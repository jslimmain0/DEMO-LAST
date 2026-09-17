// 스모크 — 두 부분:
//   ① OAuth 한 바퀴(외부 의존 없음): 가짜 FlowLink(github 모드, node:http)를 세우고 SDK 클라이언트로 401 → 동적 등록 → /authorize 페이지 → 디바이스 로그인 완료
//      → code → /token(PKCE) → Bearer 로 툴 호출까지. 사람 없이 인가 서버 전체를 검증한다.
//   ② 툴 시나리오(격리 dev 인스턴스 필요): 프로토콜 → TCP Mock → 워크플로 → 실행 → 로그 한 바퀴.
//   FLOWLINK_URL=http://localhost:18081 node test/smoke.ts     (FLOWLINK_URL 이 안 뜨면 ② 는 건너뛴다)
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js')
let n = 0
const ok = (name: string) => console.log(`  ✓ ${++n} ${name}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type Call = (name: string, args?: Record<string, unknown>, expectError?: boolean) => Promise<string>

function wrap(client: Client) {
  const call: Call = async (name, args = {}, expectError = false) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string }[]; isError?: boolean }
    const text = r.content.map((c) => c.text ?? '').join('\n')
    assert.equal(!!r.isError, expectError, `${name}: ${text}`)
    return text
  }
  return { client, call }
}

/** MCP 서버를 띄우고(임의 포트) /health 가 뜰 때까지 기다린다. */
async function spawnMcp(flowlinkUrl: string): Promise<{ proc: ChildProcess; base: string; mcpUrl: string }> {
  const port = 19100 + Math.floor(Math.random() * 400)
  // HOME 을 임시 폴더로 — 등록 클라이언트 파일(~/.flowlink/mcp-clients.json)을 개발 PC 것과 섞지 않는다
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, FLOWLINK_URL: flowlinkUrl, FLOWLINK_MCP_PORT: String(port), FLOWLINK_MCP_HOST: '127.0.0.1', HOME: tmpdir(), USERPROFILE: tmpdir() }, stdio: ['ignore', 'ignore', 'inherit'] })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return { proc, base, mcpUrl: `${base}/mcp` } } catch { /* 아직 */ }
    await sleep(100)
  }
  proc.kill(); throw new Error('MCP 서버 기동 실패')
}

async function connect(mcpUrl: string, authProvider?: OAuthClientProvider) {
  const client = new Client({ name: 'smoke', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), authProvider ? { authProvider } : undefined))
  return wrap(client)
}

// ---------- ① OAuth ----------
/**
 * 가짜 FlowLink(github 모드): 유효 토큰은 'T' 하나. 디바이스 poll 은 두 번째부터 ready. 리소스 서버처럼 무효 Bearer 는 공개 경로도 401.
 * guest=true 면 게스트 스위치가 켜진 서버 — 무토큰 요청을 게스트로 받는다(에이전트가 로그인 없이 쓰라고 켜 두는 스위치).
 */
async function fakeFlowlink(guest = false) {
  let polls = 0
  const srv = createServer((req, res) => {
    const p = new URL(req.url!, 'http://x').pathname.replace('/api/v1', '')
    const json = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
    const authed = req.headers.authorization === 'Bearer T'
    if (req.headers.authorization && !authed) return json(401, { error: 'invalid token' })
    if (p === '/auth/config') return json(200, { enabled: true, mode: 'github' })
    if (p === '/auth/github/device/start') return json(200, { sessionId: 's1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', intervalSec: 1, expiresIn: 900 })
    if (p === '/auth/github/device/poll') return json(200, ++polls < 2 ? { status: 'pending' } : { status: 'ready', token: 'T', login: 'tester' })
    if (!authed && !guest) return json(401, { error: 'login required' })
    if (!authed && p === '/auth/me') return json(200, { username: 'guest', tenant: 'default', roles: ['admin'] })
    if (!authed && p === '/admin/me') return json(200, { username: 'guest', myStatus: 'GUEST', admin: false, authenticated: false })
    if (!authed) return json(403, { error: 'approved user required' })
    if (p === '/auth/me') return json(200, { username: 'tester', tenant: 'default', roles: ['admin'] })
    if (p === '/admin/me') return json(200, { username: 'tester', myStatus: 'APPROVED', admin: true })
    json(404, { error: p })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() }
}

async function oauthScenario() {
  const fake = await fakeFlowlink()
  const h = await spawnMcp(fake.url)
  try {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }
    const post = (headers: Record<string, string>) => fetch(h.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) })
    const r401 = await post({})
    assert.equal(r401.status, 401)
    assert.match(r401.headers.get('www-authenticate') ?? '', new RegExp(`resource_metadata="${h.base}/\\.well-known/oauth-protected-resource/mcp"`)); ok('[oauth] no token → 401 + WWW-Authenticate')
    assert.equal((await post({ authorization: 'Bearer nope' })).status, 401); ok('[oauth] bad token → 401')
    const prm = await (await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`)).json()
    assert.equal(prm.resource, h.mcpUrl); assert.deepEqual(prm.authorization_servers, [h.base]); ok('[oauth] protected resource metadata')
    const asm = await (await fetch(`${h.base}/.well-known/oauth-authorization-server`)).json()
    assert.equal(asm.issuer, h.base); assert.equal(asm.token_endpoint, `${h.base}/token`); assert.equal(asm.registration_endpoint, `${h.base}/register`); ok('[oauth] authorization server metadata')

    // SDK 클라이언트(Claude Code·VS Code 가 쓰는 것과 같은 흐름): 401 → 등록 → redirectToAuthorization
    const store: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string } = {}
    let authzUrl: URL | undefined
    const redirect = 'http://127.0.0.1:19999/callback'
    const provider: OAuthClientProvider = {
      redirectUrl: redirect,
      clientMetadata: { client_name: 'Smoke Agent', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] },
      clientInformation: () => store.client, saveClientInformation: (c) => { store.client = c },
      tokens: () => store.tokens, saveTokens: (t) => { store.tokens = t },
      redirectToAuthorization: (u) => { authzUrl = u }, saveCodeVerifier: (v) => { store.verifier = v }, codeVerifier: () => store.verifier!,
      state: () => 'st-1',
    }
    const t1 = new StreamableHTTPClientTransport(new URL(h.mcpUrl), { authProvider: provider })
    await assert.rejects(new Client({ name: 'smoke', version: '0' }).connect(t1), UnauthorizedError); ok('[oauth] client connect → UnauthorizedError (browser redirect requested)')
    assert.ok(store.client?.client_id, '동적 등록된 client_id'); ok('[oauth] dynamic client registration')
    assert.ok(authzUrl && authzUrl.pathname === '/authorize' && authzUrl.searchParams.get('code_challenge_method') === 'S256'); ok('[oauth] authorize url with PKCE')

    // 브라우저 역할: 로그인 페이지 → 시작 → 폴링 → redirect
    const page = await fetch(authzUrl!)
    const html = await page.text()
    assert.equal(page.status, 200); assert.match(html, /GitHub 로 로그인/); assert.match(html, /<b>Smoke Agent<\/b>/); ok('[oauth] /authorize renders login page (client name shown)')
    const tx = /const tx = "([0-9a-f-]{36})"/.exec(html)![1]
    const st = await (await fetch(`${h.base}/login/start?tx=${tx}`, { method: 'POST' })).json()
    assert.equal(st.userCode, 'ABCD-1234'); ok('[oauth] /login/start → device code')
    let poll: { status: string; redirect?: string } = { status: '' }
    for (let i = 0; i < 10 && poll.status !== 'ready'; i++) { poll = await (await fetch(`${h.base}/login/poll?tx=${tx}`)).json(); if (poll.status !== 'ready') await sleep(100) }
    assert.equal(poll.status, 'ready')
    const ru = new URL(poll.redirect!)
    assert.equal(ru.origin + ru.pathname, redirect); assert.equal(ru.searchParams.get('state'), 'st-1'); assert.ok(ru.searchParams.get('code')); ok('[oauth] device ready → redirect_uri?code&state')
    assert.equal((await (await fetch(`${h.base}/login/poll?tx=${tx}`)).json()).status, 'error'); ok('[oauth] tx is consumed')

    // 클라이언트 역할: code → token(PKCE) → 재접속 → 툴 호출
    const code = ru.searchParams.get('code')!
    await t1.finishAuth(code)
    assert.equal(store.tokens?.access_token, 'T'); assert.equal(store.tokens?.token_type, 'bearer'); ok('[oauth] token exchange (PKCE) → app JWT')
    await assert.rejects(t1.finishAuth(code)); ok('[oauth] code is single-use')
    const c2 = await connect(h.mcpUrl, provider)
    const stt = await c2.call('flowlink_status')
    assert.match(stt, /auth mode: github/); assert.match(stt, /login: tester/); assert.match(stt, /APPROVED/); ok('[oauth] authenticated tool call as tester')
    assert.ok(!(await c2.client.listTools()).tools.some((t) => t.name.startsWith('flowlink_login'))); ok('[oauth] no login tools (browser does it)')
    await c2.client.close()
  } finally { h.proc.kill(); fake.close() }

  // 게스트 스위치 ON — 무토큰은 게스트로 통과(로그인 강요 없음), 무효 토큰은 여전히 401(재로그인), 게스트 403 은 로그인 안내.
  const gf = await fakeFlowlink(true)
  const g = await spawnMcp(gf.url)
  try {
    const anon = await connect(g.mcpUrl)
    const st = await anon.call('flowlink_status')
    assert.match(st, /auth mode: github/); assert.match(st, /게스트\(게스트 스위치 ON\)/); ok('[guest] no token → guest, no 401')
    assert.match(await anon.call('protocol_list', {}, true), /HTTP 403.*게스트는 여기까지.*인증\(로그인\)/s); ok('[guest] guest 403 → login hint')
    await anon.client.close()
    const r = await fetch(g.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer nope' }, body: '{}' })
    assert.equal(r.status, 401); ok('[guest] bad token → 401 (re-login)')
  } finally { g.proc.kill(); gf.close() }
}

// ---------- ② 툴 시나리오(dev 인스턴스) ----------
const SPEC = {
  encoding: 'EUC-KR', lengthField: '전문길이', discriminator: '거래코드',
  header: [{ name: '전문길이', len: 4, type: 'length' }, { name: '거래코드', len: 4, type: 'ascii' }],
  messages: [
    { key: '0210', label: '잔액조회 요청', fields: [{ name: '계좌번호', len: 13, type: 'ascii' }, { name: '고객명', len: 20, type: 'string' }] },
    { key: '0211', label: '잔액조회 응답', fields: [{ name: '응답코드', len: 4, type: 'ascii' }, { name: '잔액', len: 15, type: 'numeric' }] },
  ],
}

async function scenario({ client, call }: { client: Client; call: Call }, base: string, PORT: number) {
  const tools = (await client.listTools()).tools.map((t) => t.name)
  assert.ok(tools.includes('flow_run') && tools.includes('protocol_upsert') && tools.includes('mock_send'), tools.join())
  ok(`tools ${tools.length}`)

  const st = await call('flowlink_status')
  assert.match(st, /dev 모드/); assert.match(st, /transport: http/); ok('status dev')
  assert.match(await call('flowlink_guide', { topic: 'rules' }), /지어내지 않는다/); ok('guide rules')
  assert.match(await call('flowlink_guide', { topic: 'protocol' }), /lengthField|header/); ok('guide protocol')
  assert.match(await call('flowlink_guide', { topic: 'nodes' }), /tcp:|transform:|START/); ok('guide nodes (node reference)')

  const pl = await call('plugin_list')
  assert.match(pl, /변환\(transform\)/); assert.match(pl, /코덱\(codec\)/); ok('plugin_list transforms+codecs')
  assert.match(await call('transform_preview', { id: 'no-such-plugin', inputs: { a: '1' } }), /알 수 없는 변환/); ok('transform_preview unknown id')

  const pname = `smoke-${Date.now()}`
  const p1 = await call('protocol_upsert', { name: pname, spec: SPEC })
  assert.match(p1, /^생성: /); assert.match(p1, /0210/); ok('protocol create')
  const pid = /\[([0-9a-f-]{36})\]/.exec(p1)![1]
  assert.match(await call('protocol_upsert', { name: pname, spec: JSON.stringify(SPEC) }), /^갱신: /); ok('protocol update (string spec)')
  assert.match(await call('protocol_list'), new RegExp(pname)); ok('protocol list')
  const pv = await call('protocol_preview', { name: pname, key: '0210', values: { '계좌번호': '1122334567890', '고객명': '김철수' } })
  assert.match(pv, /총 41B/); assert.match(pv, /@8 계좌번호/); ok('protocol preview bytes')
  assert.match(await call('protocol_preview', { protocolId: pid, key: '0210', values: { '계좌번호': '12345678901234' } }), /⚠/); ok('protocol preview error surfaced')
  assert.match(await call('protocol_upsert', { name: pname + '-bad', spec: { encoding: 'EUC-KR', header: [] } }, true), /HTTP 400/); ok('protocol validation error → isError')

  const slug = `smk${String(PORT)}`
  const tcpSpec = { tcp: { port: PORT, protocolId: pid, timeoutMs: 3000, rules: [
    { id: 'r1', when: [{ field: '계좌번호', op: 'eq', value: '1122334567890' }], then: { mode: 'mock', fields: { '거래코드': '0211', '응답코드': '0000', '잔액': '1500' } } },
    { id: 'r2', when: [], then: { mode: 'mock', fields: { '거래코드': '0211', '응답코드': '9999', '잔액': '0' } } },
  ] } }
  const m1 = await call('mock_upsert', { name: 'smoke tcp', slug, type: 'TCP', spec: tcpSpec })
  assert.match(m1, /^생성: /); assert.match(m1, /LISTENING/); ok('tcp mock create + listening')
  assert.match(await call('mock_list'), new RegExp(slug)); ok('mock list')
  const s1 = await call('mock_send', { slug, key: '0210', values: { '계좌번호': '1122334567890', '고객명': '김철수' } })
  assert.match(s1, /전문 0211/); assert.match(s1, /응답코드=0000/); assert.match(s1, /잔액=1500/); ok('mock_send matched rule')
  const s2 = await call('mock_send', { slug, key: '0210', values: { '계좌번호': '0000000000000' } })
  assert.match(s2, /응답코드=9999/); ok('mock_send fallback rule')
  const lg = await call('mock_log', { slug, limit: 10 })
  assert.match(lg, /→ \[mock\] 0210/); assert.match(lg, /← \[mock\] 0211/); ok('mock_log rows')
  assert.match(await call('mock_get', { slug }), /"protocolId"/); ok('mock_get spec')

  const graph = { nodes: [
    { id: 'start', type: 'start', name: '시작', x: 0, y: 0 },
    { id: 'tcp1', type: 'tcp', name: '잔액조회', x: 260, y: 0, protocolId: pid, tcpMessage: '0210', tcpResponseMessage: '0211', tcpHost: '127.0.0.1', tcpPort: PORT, tcpTimeoutMs: 3000,
      tcpValues: { '계좌번호': '{{ acct@input }}', '고객명': '김철수' } },
    { id: 'chk', type: 'assert', name: '검증', x: 520, y: 0, condition: "{{ 응답코드@tcp1 }} == '0000'" },
    { id: 'memo', type: 'note', name: '메모', x: 260, y: 160, noteText: '확인 필요: 계좌번호는 input 으로 받음' },
    { id: 'end', type: 'end', name: '끝', x: 780, y: 0 },
  ], edges: [{ from: 'start', to: 'tcp1' }, { from: 'tcp1', to: 'chk' }, { from: 'chk', to: 'end' }] }
  const f1 = await call('flow_upsert', { name: `smoke flow ${Date.now()}`, graph, note: 'smoke' })
  assert.match(f1, /^저장: flow /); ok('flow create')
  const fid = /flow ([0-9a-f-]{36})/.exec(f1)![1]
  assert.match(await call('flow_get', { id: fid }), /"tcp1"/); ok('flow_get graph')
  assert.match(await call('flow_upsert', { id: fid, graph: { nodes: [{ id: 'x', type: 'http' }, { id: 'x', type: 'end' }], edges: [] } }, true), /중복된 노드 id/); ok('flow validation error → isError')

  const r1 = await call('flow_run', { id: fid, input: { acct: '1122334567890' }, timeoutSec: 30 })
  assert.match(r1, /SUCCEEDED/); assert.match(r1, /tcp1.*✓/); assert.match(r1, /출력: .*응답코드/); ok('flow_run SUCCEEDED with tcp output')
  const eid = /실행 ([0-9a-f-]{36})/.exec(r1)![1]
  const r2 = await call('flow_run', { id: fid, input: { acct: '0000000000000' }, timeoutSec: 30 })
  assert.match(r2, /FAILED/); assert.match(r2, /chk.*✕/); ok('flow_run FAILED on assert')
  assert.match(await call('execution_get', { id: eid, full: true }), /SUCCEEDED/); ok('execution_get')
  assert.match(await call('execution_list', { flowId: fid }), new RegExp(eid)); ok('execution_list')

  // ---- 실행 제어: 노드 단독 실행 · 재실행 · 필터 · input 노드 재개 · 스위트
  assert.match(await call('node_run', { flowId: fid, nodeId: 'tcp1', input: { acct: '1122334567890' } }), /tcp1 ✓[\s\S]*응답코드/); ok('node_run tcp node')
  assert.match(await call('execution_rerun', { id: eid }), /SUCCEEDED/); ok('execution_rerun')
  const el = await call('execution_list', { status: 'FAILED', flowId: fid })
  assert.match(el, /FAILED/); assert.doesNotMatch(el, /SUCCEEDED/); ok('execution_list status filter')
  const g2 = { nodes: [
    { id: 'start', type: 'start', name: '시작', x: 0, y: 0 },
    { id: 'ask', type: 'input', name: '계좌 입력', x: 130, y: 0, waitMsg: '계좌번호?', waitFields: [{ id: 'w', key: 'acct', label: '계좌번호', type: 'string' }] },
    { ...graph.nodes[1], tcpValues: { '계좌번호': '{{ acct@ask }}', '고객명': '김철수' } },
    graph.nodes[2], graph.nodes[4],
  ], edges: [{ from: 'start', to: 'ask' }, { from: 'ask', to: 'tcp1' }, { from: 'tcp1', to: 'chk' }, { from: 'chk', to: 'end' }] }
  const f3 = await call('flow_upsert', { name: `smoke input ${Date.now()}`, graph: g2 })
  const fid3 = /flow ([0-9a-f-]{36})/.exec(f3)![1]
  const r3 = await call('flow_run', { id: fid3, timeoutSec: 20 })
  assert.match(r3, /⏸ 대기 중: 입력\(input\) 노드/); ok('flow_run pauses at input node')
  const eid3 = /실행 ([0-9a-f-]{36})/.exec(r3)![1]
  assert.match(await call('execution_resume', { id: eid3, values: { acct: '1122334567890' } }), /SUCCEEDED[\s\S]*chk.*✓/); ok('execution_resume(values) → SUCCEEDED')
  assert.match(await call('execution_resume', { id: eid3 }), /대기 중인 노드가 없습니다/); ok('execution_resume nothing pending')

  // ---- 버전
  // 생성 시 v1(빈 그래프) + 첫 저장 v2 → 이 저장은 v3
  const up = await call('flow_upsert', { id: fid, graph, note: 'again' })
  const vNow = Number(/ v(\d+) /.exec(up)![1]); assert.ok(vNow >= 2, up); ok(`flow_upsert existing → v${vNow}`)
  const vs = await call('flow_versions', { id: fid })
  assert.match(vs, new RegExp(`^v${vNow} .*· again`, 'm')); assert.match(vs, /^v1 /m); ok('flow_versions')
  assert.match(await call('flow_version', { id: fid, versionNo: vNow }), /"tcp1"/); ok('flow_version get graph')
  const rs = await call('flow_version', { id: fid, versionNo: vNow, restore: true })
  const vRestored = Number(new RegExp(`복원: v${vNow} → 새 버전 v(\\d+)`).exec(rs)![1]); ok('flow_version restore')
  assert.match(await call('flow_version', { id: fid, versionNo: vRestored, pinned: true }), new RegExp(`v${vRestored} 고정`)); assert.match(await call('flow_versions', { id: fid }), new RegExp(`^v${vRestored} 📌`, 'm')); ok('flow_version pin')
  const mvs = await call('mock_versions', { slug })
  const mv = Number(/^v(\d+)/.exec(mvs)![1]); ok('mock_versions')
  assert.match(await call('mock_version', { slug, versionNo: mv }), /"protocolId"/); ok('mock_version get spec')
  assert.match(await call('mock_version', { slug, versionNo: mv, restore: true }), new RegExp(`복원: v${mv} → 새 버전 v\\d+`)); ok('mock_version restore')

  // ---- Mock 부가
  assert.match(await call('mock_state', { slug }), /요청 \d+ · seq \d+\n상태: /); ok('mock_state')
  assert.match(await call('mock_reset', { slug }), /초기화됨/); ok('mock_reset')
  assert.match(await call('mock_clear_log', { slug }), /로그 비움/); assert.match(await call('mock_log', { slug }), /로그 없음/); ok('mock_clear_log')
  assert.match(await call('mock_usages', {}), /←|참조하는 워크플로 없음/); ok('mock_usages')
  assert.match(await call('codec_try', { slug, codec: { request: [] }, message: 'hello' }), /결과: hello/); ok('codec_try passthrough')
  assert.match(await call('codec_try', { slug, codec: { request: [{ id: 'nope', target: 'body' }] }, message: 'x' }, true), /알 수 없는 변환 플러그인/); ok('codec_try unknown plugin → isError')
  assert.match(await call('mock_list', { workspace: '공용' }), new RegExp(slug)); ok('mock_list workspace filter')

  // ---- 워크스페이스 · 폴더 — 이름/경로로 지목
  const wl = await call('workspace_list')
  assert.match(wl, /공용 \[public\] PUBLIC/); assert.match(wl, /PERSONAL/); ok('workspace_list')
  const personal = /^(.+) \[[0-9a-f-]{36}\] PERSONAL/m.exec(wl)![1]
  const fname = `smoke-folder-${Date.now()}`
  assert.match(await call('folder_create', { name: fname }), /^생성: /); ok('folder_create')
  assert.match(await call('folder_create', { name: 'sub', parent: fname }), new RegExp(`생성: ${fname}/sub`)); ok('folder_create nested (parent by name)')
  assert.match(await call('folder_list'), new RegExp(`${fname}/sub \\[[0-9a-f-]{36}\\] 워크플로 0`)); ok('folder_list paths')
  const f2 = await call('flow_upsert', { name: 'smoke in folder', graph, folder: `${fname}/sub` })
  const fid2 = /flow ([0-9a-f-]{36})/.exec(f2)![1]
  assert.match(await call('flow_list', { folder: `${fname}/sub` }), new RegExp(`^${fname}/sub/smoke in folder \\[${fid2}\\]`, 'm')); ok('flow_upsert into folder by path + flow_list(folder)')
  assert.match(await call('flow_list', { folder: 'no-such-folder' }, true), /폴더 없음.*있는 폴더/); ok('unknown folder → error lists folders')
  assert.match(await call('flow_list', { workspace: 'no-such-ws' }, true), /워크스페이스 없음.*공용/); ok('unknown workspace → error lists workspaces')
  assert.match(await call('workspace_get', {}), new RegExp(`📁 ${fname}/sub \\[[0-9a-f-]{36}\\]\\n  - smoke in folder \\[${fid2}\\]`)); ok('workspace_get tree')
  assert.match(await call('flow_update', { id: fid2, name: 'smoke renamed', folder: '/' }), /변경: smoke renamed \[.*폴더 \(루트\)/); ok('flow_update rename + move to root')
  assert.match(await call('flow_update', { id: fid2, folder: fname }), new RegExp(`폴더 [0-9a-f-]{36}`)); ok('flow_update move into folder by name')
  assert.match(await call('folder_update', { folder: `${fname}/sub`, name: 'sub2' }), new RegExp(`변경: ${fname}/sub2`)); ok('folder_update rename')
  assert.match(await call('suite_run', { folder: fname, timeoutSec: 60 }), /^\d\/1 성공\n[✓✕] smoke renamed \[[0-9a-f-]{36}\] (SUCCEEDED|FAILED)/); ok('suite_run folder')
  assert.match(await call('flow_upsert', { name: 'smoke personal', graph, workspace: personal }), /^저장: /); ok('flow_upsert into personal workspace by name')
  const pfl = await call('flow_list', { workspace: personal })
  assert.match(pfl, /smoke personal/); assert.doesNotMatch(pfl, /smoke renamed/); ok('flow_list(workspace) scoped')
  await call('flow_delete', { id: /\[([0-9a-f-]{36})\]/.exec(pfl)![1] })
  assert.match(await call('workspace_export', {}), /"flows"/); ok('workspace_export')

  const env = `smoke-${Date.now()}`
  assert.match(await call('env_put', { name: env, vars: { host: '127.0.0.1' } }), /1개/); ok('env_put')
  assert.match(await call('env_list'), new RegExp(`${env}: host=127.0.0.1`)); ok('env_list')
  assert.match(await call('env_rename', { name: env, to: env + '-r' }), /이름 변경/); assert.match(await call('env_list'), new RegExp(`${env}-r:`)); ok('env_rename')
  assert.match(await call('env_delete', { name: env + '-r' }), /삭제됨/); ok('env_delete')
  assert.match(await call('flow_run_input', { id: fid, vars: { acct: '1' } }), /저장 · 기본 입력: acct=1/); assert.match(await call('flow_run_input', { id: fid }), /acct=1/); ok('flow_run_input put/get')
  assert.match(await call('secret_list'), /시크릿 없음|\(공통\)|\(/); ok('secret_list')

  const hslug = `smkh${String(PORT)}`
  const h1 = await call('mock_upsert', { name: 'smoke http', slug: hslug, type: 'HTTP', spec: { routes: [{ id: 'r', method: 'ANY', path: '/ping', rules: [{ id: 'k', status: 200, contentType: 'json', body: '{"ok":true}' }] }] } })
  assert.match(h1, /HTTP on/); ok('http mock create')
  const hr = await call('http_request', { url: `/mock/${hslug}/ping` })
  assert.match(hr, /HTTP 200/); assert.match(hr, /"ok":true/); ok('http_request → mock served (curl 대신)')
  assert.match(await call('http_request', { method: 'POST', url: `${base}/mock/${hslug}/ping`, body: { a: 1 } }), /HTTP 200/); ok('http_request absolute url + body')
  assert.match(await call('mock_log', { slug: hslug }), /GET \/ping → 200/); ok('http mock_log')
  assert.match(await call('mock_delete', { slug: hslug }), /삭제됨/); ok('http mock delete')
  assert.match(await call('mock_delete', { slug }), /삭제됨/); ok('tcp mock delete')
  assert.match(await call('protocol_delete', { id: pid }), /삭제됨/); ok('protocol delete')
  assert.match(await call('mock_get', { slug }, true), /Mock 없음/); ok('deleted mock → isError')
  for (const id of [fid, fid2, fid3]) assert.match(await call('flow_delete', { id }), /삭제됨/)
  ok('flow_delete ×3')
  assert.match(await call('folder_delete', { folder: `${fname}/sub2` }), /삭제됨/); assert.match(await call('folder_delete', { folder: fname }), /삭제됨/); ok('folder_delete')
  await client.close()
}

async function main() {
  await oauthScenario()

  const base = process.env.FLOWLINK_URL || 'http://localhost:18081'
  let up = false
  try { up = (await fetch(`${base}/api/v1/auth/me`)).ok } catch { /* 안 떠 있음 */ }
  if (!up) { console.log(`  (${base} 에 익명 허용 FlowLink(dev/게스트)가 없음 — 툴 시나리오 건너뜀)`); console.log(`ALL ${n} PASS`); return }
  const http = await spawnMcp(base)
  try {
    const r405 = await fetch(http.mcpUrl); assert.equal(r405.status, 405); ok('GET /mcp → 405 (stateless)')
    await scenario(await connect(http.mcpUrl), base, 19540 + Math.floor(Math.random() * 400))
    // 동시 요청 — 요청별 서버/transport 격리(request id 충돌 없음)
    const c2 = await connect(http.mcpUrl)
    const texts = await Promise.all([1, 2, 3, 4, 5].map(() => c2.call('flowlink_guide', { topic: 'rules' })))
    assert.ok(texts.every((t) => /지어내지 않는다/.test(t))); ok('5 concurrent calls')
    await c2.client.close()
  } finally { http.proc.kill() }
  console.log(`ALL ${n} PASS`)
}
main().catch((e) => { console.error('FAIL', e); process.exit(1) })
