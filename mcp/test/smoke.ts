// 스모크: 격리 FlowLink(dev 모드) 에 MCP 클라이언트로 붙어 프로토콜 → TCP Mock → 워크플로 → 실행 → 로그 한 바퀴.
//   FLOWLINK_URL=http://localhost:18081 node test/smoke.ts
//   FLOWLINK_GH_URL=http://localhost:18082 (선택) — github 모드 인스턴스: 게스트 상태·로그인 코드 발급만 확인.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js')
let n = 0
const ok = (name: string) => console.log(`  ✓ ${++n} ${name}`)

async function connect(url: string) {
  const client = new Client({ name: 'smoke', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, FLOWLINK_URL: url, FLOWLINK_TOKEN: '' } as Record<string, string> }))
  const call = async (name: string, args: Record<string, unknown> = {}, expectError = false): Promise<string> => {
    const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string }[]; isError?: boolean }
    const text = r.content.map((c) => c.text ?? '').join('\n')
    assert.equal(!!r.isError, expectError, `${name}: ${text}`)
    return text
  }
  return { client, call }
}

const PORT = 19540 + Math.floor(Math.random() * 400)
const SPEC = {
  encoding: 'EUC-KR', lengthField: '전문길이', discriminator: '거래코드',
  header: [{ name: '전문길이', len: 4, type: 'length' }, { name: '거래코드', len: 4, type: 'ascii' }],
  messages: [
    { key: '0210', label: '잔액조회 요청', fields: [{ name: '계좌번호', len: 13, type: 'ascii' }, { name: '고객명', len: 20, type: 'string' }] },
    { key: '0211', label: '잔액조회 응답', fields: [{ name: '응답코드', len: 4, type: 'ascii' }, { name: '잔액', len: 15, type: 'numeric' }] },
  ],
}

async function main() {
  const base = process.env.FLOWLINK_URL || 'http://localhost:18081'
  const { client, call } = await connect(base)
  const tools = (await client.listTools()).tools.map((t) => t.name)
  assert.ok(tools.includes('flow_run') && tools.includes('protocol_upsert') && tools.includes('mock_send'), tools.join())
  ok(`tools ${tools.length}`)

  assert.match(await call('flowlink_status'), /dev 모드/); ok('status dev')
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
  const h1 = await call('mock_upsert', { name: 'smoke http', slug: hslug, type: 'HTTP', spec: { routes: [{ id: 'r', method: 'GET', path: '/ping', rules: [{ id: 'k', status: 200, contentType: 'json', body: '{"ok":true}' }] }] } })
  assert.match(h1, /HTTP on/); ok('http mock create')
  const pr = await fetch(`${base}/mock/${hslug}/ping`); assert.equal(pr.status, 200); ok('http mock served')
  assert.match(await call('mock_log', { slug: hslug }), /GET \/ping → 200/); ok('http mock_log')
  assert.match(await call('mock_delete', { slug: hslug }), /삭제됨/); ok('http mock delete')
  assert.match(await call('mock_delete', { slug }), /삭제됨/); ok('tcp mock delete')
  assert.match(await call('protocol_delete', { id: pid }), /삭제됨/); ok('protocol delete')
  assert.match(await call('mock_get', { slug }, true), /Mock 없음/); ok('deleted mock → isError')
  await client.close()

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
  } else console.log('  (FLOWLINK_GHGUEST_URL 없음 — 게스트 모드 검사 건너뜀)')
  console.log(`ALL ${n} PASS`)
}
main().catch((e) => { console.error('FAIL', e); process.exit(1) })
