// 스모크: 격리 FlowLink(dev 모드) 에 MCP 클라이언트로 붙어 프로토콜 → TCP Mock → 워크플로 → 실행 → 로그 한 바퀴.
//   같은 시나리오를 두 전송으로 돈다: ① stdio(로컬 프로세스) ② Streamable HTTP(--http 로 띄운 서버, 세션 없음) — 툴 코드가 하나라 동작이 같아야 한다.
//   FLOWLINK_URL=http://localhost:18081 node test/smoke.ts
//   FLOWLINK_GH_URL=http://localhost:18082 (선택) — github 모드 인스턴스: 게스트 상태·로그인 코드 발급만 확인(stdio).
//   FLOWLINK_GHGUEST_URL=... (선택) — github+게스트 인스턴스: 게스트 읽기·승인 게이트(stdio) + HTTP 모드 Authorization 헤더 전달.
//   FLOWLINK_GHGUEST_TOKEN=<앱 JWT> (선택, GHGUEST 와 함께) — HTTP 모드에서 헤더 토큰이 REST 로 전달되는지(protocol_upsert 가 403 이 아닌지).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js')
let n = 0
const ok = (name: string) => console.log(`  ✓ ${++n} ${name}`)
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

async function connect(url: string) {
  const client = new Client({ name: 'smoke', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, FLOWLINK_URL: url, FLOWLINK_TOKEN: '' } as Record<string, string> }))
  return wrap(client)
}

/** --http 로 서버를 띄우고(임의 포트) /health 가 뜰 때까지 기다린다. */
async function spawnHttp(url: string): Promise<{ proc: ChildProcess; mcpUrl: string }> {
  const port = 19100 + Math.floor(Math.random() * 400)
  const proc = spawn(process.execPath, [SERVER, '--http'], { env: { ...process.env, FLOWLINK_URL: url, FLOWLINK_TOKEN: '', FLOWLINK_MCP_PORT: String(port), FLOWLINK_MCP_HOST: '127.0.0.1' }, stdio: ['ignore', 'ignore', 'inherit'] })
  const mcpUrl = `http://127.0.0.1:${port}/mcp`
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return { proc, mcpUrl } } catch { /* 아직 */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  proc.kill(); throw new Error('HTTP 서버 기동 실패')
}

async function connectHttp(mcpUrl: string, headers?: Record<string, string>) {
  const client = new Client({ name: 'smoke-http', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), headers ? { requestInit: { headers } } : undefined))
  return wrap(client)
}

const SPEC = {
  encoding: 'EUC-KR', lengthField: '전문길이', discriminator: '거래코드',
  header: [{ name: '전문길이', len: 4, type: 'length' }, { name: '거래코드', len: 4, type: 'ascii' }],
  messages: [
    { key: '0210', label: '잔액조회 요청', fields: [{ name: '계좌번호', len: 13, type: 'ascii' }, { name: '고객명', len: 20, type: 'string' }] },
    { key: '0211', label: '잔액조회 응답', fields: [{ name: '응답코드', len: 4, type: 'ascii' }, { name: '잔액', len: 15, type: 'numeric' }] },
  ],
}

/** dev 인스턴스 한 바퀴 — 전송(stdio/http)과 무관하게 같아야 한다. PORT 는 TCP Mock 리스너 포트(전송별로 다르게). */
async function scenario({ client, call }: { client: Client; call: Call }, base: string, PORT: number, transport: 'stdio' | 'http') {
  const tools = (await client.listTools()).tools.map((t) => t.name)
  assert.ok(tools.includes('flow_run') && tools.includes('protocol_upsert') && tools.includes('mock_send'), tools.join())
  if (transport === 'http') assert.ok(!tools.includes('flowlink_login') && !tools.includes('flowlink_logout'), '로그인 툴은 HTTP 모드에 없어야 한다: ' + tools.join())
  else assert.ok(tools.includes('flowlink_login') && tools.includes('flowlink_login_wait'), tools.join())
  ok(`[${transport}] tools ${tools.length}`)

  const st = await call('flowlink_status')
  assert.match(st, /dev 모드/); assert.match(st, transport === 'http' ? /transport: http/ : /transport: stdio/); ok('status dev + transport')
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

  const env = `smoke-${Date.now()}`
  assert.match(await call('env_put', { name: env, vars: { host: '127.0.0.1' } }), /1개/); ok('env_put')
  assert.match(await call('env_list'), new RegExp(`${env}: host=127.0.0.1`)); ok('env_list')

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
  await client.close()
}

async function main() {
  const base = process.env.FLOWLINK_URL || 'http://localhost:18081'
  // ① stdio
  await scenario(await connect(base), base, 19540 + Math.floor(Math.random() * 400), 'stdio')
  // ② Streamable HTTP(세션 없음) — 같은 시나리오. 요청마다 새 McpServer 라 상태가 새지 않는지도 이 한 바퀴가 확인한다.
  const http = await spawnHttp(base)
  try {
    const r405 = await fetch(http.mcpUrl); assert.equal(r405.status, 405); ok('[http] GET /mcp → 405 (stateless)')
    await scenario(await connectHttp(http.mcpUrl), base, 19540 + Math.floor(Math.random() * 400), 'http')
    // 동시 요청 — 요청별 서버/transport 격리(request id 충돌 없음)
    const c2 = await connectHttp(http.mcpUrl)
    const texts = await Promise.all([1, 2, 3, 4, 5].map(() => c2.call('flowlink_guide', { topic: 'rules' })))
    assert.ok(texts.every((t) => /지어내지 않는다/.test(t))); ok('[http] 5 concurrent calls')
    await c2.client.close()
  } finally { http.proc.kill() }

  const gh = process.env.FLOWLINK_GH_URL
  if (gh) {
    // github 강제 로그인(기본, guest-enabled=false): 무토큰이면 모든 API 401, flowlink_status 가 "로그인 필수" 안내.
    const g = await connect(gh)
    const st = await g.call('flowlink_status')
    assert.match(st, /auth mode: github/); assert.match(st, /로그인 필수/); ok('github force-login: status says login required')
    assert.match(await g.call('protocol_list', {}, true), /HTTP 401/); assert.match(await g.call('protocol_list', {}, true), /flowlink_login 을 호출/); ok('github force-login: 401 → login hint')
    const lg2 = await g.call('flowlink_login')
    assert.match(lg2, /github\.com\/login\/device/); assert.match(lg2, /코드 입력: +[A-Z0-9-]+/); assert.match(lg2, /sessionId="/); ok('github force-login: device code issued')
    assert.match(await g.call('flowlink_login_wait', { sessionId: /sessionId="([^"]+)"/.exec(lg2)![1], timeoutSec: 5 }), /아직 승인되지 않았습니다/); ok('github force-login: login_wait pending')
    await g.client.close()
  } else console.log('  (FLOWLINK_GH_URL 없음 — github 강제 로그인 검사 건너뜀)')

  const ghGuest = process.env.FLOWLINK_GHGUEST_URL
  if (ghGuest) {
    // github + guest-enabled=true(MCP 에이전트용): 무토큰으로 읽기/워크플로 가능, 프로토콜 저장은 승인 게이트(403).
    const g = await connect(ghGuest)
    const st = await g.call('flowlink_status')
    assert.match(st, /auth mode: github/); assert.match(st, /게스트 모드 ON/); ok('github guest-on: status says guest mode')
    assert.match(await g.call('flow_list'), /워크플로|없음/); ok('github guest-on: guest can read flows')
    assert.match(await g.call('protocol_upsert', { name: 'x', spec: SPEC }, true), /HTTP 403/); ok('github guest-on: protocol write → 403 (approval gate)')
    await g.client.close()
    // HTTP 모드: 무토큰 = 게스트, Authorization 헤더 = 그 사용자(REST 로 그대로 전달)
    const h = await spawnHttp(ghGuest)
    try {
      const anon = await connectHttp(h.mcpUrl)
      const st2 = await anon.call('flowlink_status')
      assert.match(st2, /transport: http/); assert.match(st2, /게스트 모드 ON/); ok('github guest-on [http]: no header → guest')
      assert.match(await anon.call('protocol_upsert', { name: 'x', spec: SPEC }, true), /HTTP 403/); ok('github guest-on [http]: no header → write 403')
      await anon.client.close()
      const bad = await connectHttp(h.mcpUrl, { Authorization: 'Bearer not-a-jwt' })
      assert.match(await bad.call('flowlink_status'), /만료됐거나 무효/); ok('github guest-on [http]: bad header token → invalid hint')
      await bad.client.close()
      const tok = process.env.FLOWLINK_GHGUEST_TOKEN
      if (tok) {
        const me = await connectHttp(h.mcpUrl, { Authorization: `Bearer ${tok}` })
        assert.match(await me.call('flowlink_status'), /login: /); ok('github guest-on [http]: header token → logged in as user')
        await me.client.close()
      }
    } finally { h.proc.kill() }
  } else console.log('  (FLOWLINK_GHGUEST_URL 없음 — 게스트 모드 검사 건너뜀)')
  console.log(`ALL ${n} PASS`)
}
main().catch((e) => { console.error('FAIL', e); process.exit(1) })
