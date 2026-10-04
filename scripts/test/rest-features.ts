// 격리 인스턴스 전용. 생성한 lab-* 리소스는 UI 확인용으로 남긴다.
// REST와 실행 엔진만 검증한다. MCP 프로토콜/도구를 호출하지 않는다.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = process.env.FLOWLINK_URL
assert.ok(base && new URL(base).hostname === '127.0.0.1', '격리 localhost FLOWLINK_URL을 지정하세요.')
const internal = process.env.FLOWLINK_EXECUTION_URL || base
const remote = process.env.FLOWLINK_TARGET === 'server'
const agent = process.env.FLOWLINK_AGENT_FILE ? JSON.parse(readFileSync(process.env.FLOWLINK_AGENT_FILE, 'utf8')) : null
const workspaceId = process.env.FLOWLINK_WORKSPACE_ID
const repo = fileURLToPath(new URL('../../', import.meta.url))
const tag = `lab-${Date.now()}`
const fixtures: Record<string, string> = {}
let checks = 0
const ok = (name: string) => console.log(`PASS ${++checks} ${name}`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function request(path: string, method = 'GET', body?: unknown, expected = 200) {
  const api = path.startsWith('/api/')
  const destination = (api ? base : internal) + (api && remote ? path.replace('/api/v1', '/api/v1/remote') : path)
  const res = await fetch(destination, { method, headers: {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(api && process.env.FLOWLINK_TOKEN ? { authorization: `Bearer ${process.env.FLOWLINK_TOKEN}` } : {}),
    ...(api && agent ? { 'X-FlowLink-Local': agent.token } : {}),
  }, redirect: 'error', body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  assert.equal(res.status, expected, `${method} ${path}: ${text}`)
  try { return JSON.parse(text) } catch { return text }
}
const edge = (from: string, to: string, fromPort = 'out') => ({ id: `${from}-${fromPort}-${to}`, from, to, fromPort })
const node = (id: string, type: string, extra = {}) => ({ id, type, name: id, x: Object.keys(fixtures).length * 20, y: 0, ...extra })
async function flow(name: string, middle: any[], links?: any[]) {
  const nodes = [node('start', 'start'), ...middle, node('end', 'end')].map((n, i) => ({ ...n, x: i * 210 }))
  const graph = { nodes, edges: links || nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id)) }
  const created = await request('/api/v1/flows', 'POST', { name: `${tag} ${name}`, workspaceId }, 201)
  await request(`/api/v1/flows/${created.id}/versions`, 'POST', { graph }, 201)
  fixtures[name] = created.id
  return created.id as string
}
async function settle(id: string, terminal = false, timeout = 12000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const detail = await request(`/api/v1/executions/${id}`)
    if (detail.pendingAgent?.status === 'UNKNOWN') throw Error(`처리 결과 확인 필요: ${id}`)
    if (detail.status !== 'RUNNING' && !detail.pendingAgent && (!terminal || detail.status !== 'WAITING')) return detail
    await sleep(100)
  }
  throw Error(`실행 완료 제한시간 초과: ${id}`)
}
async function run(id: string, body = {}) {
  return settle((await request(`/api/v1/flows/${id}/runs`, 'POST', body)).id)
}

const previousRelay = await request('/api/v1/settings/relay')
const previousNotify = await request('/api/v1/settings/notify')
const slug = tag
const triggersToDisable: string[] = []
try {
  await request('/api/v1/settings/relay', 'PUT', { value: internal })
  const createdMock = await request('/api/v1/mock-servers', 'POST', { name: tag, slug, type: 'HTTP', workspaceId }, 201)
  const mockPath = createdMock.basePath
  assert.ok(typeof mockPath === 'string' && mockPath.startsWith('/mock/ws/'), '워크스페이스 Mock 경로가 필요합니다.')
  await request(`/api/v1/mock-servers/${createdMock.id}/spec`, 'PUT', { spec: { routes: [
    { id: 'ping', method: 'ANY', path: '/ping', rules: [{ id: 'ping', status: 200, contentType: 'json', body: '{"ok":true}' }] },
    { id: 'state', method: 'GET', path: '/state', rules: [
      { id: 'first', status: 200, contentType: 'json', body: '{"phase":"pending"}', repeat: 1, setState: [{ key: 'seen', value: '1', op: 'incr' }] },
      { id: 'next', status: 200, contentType: 'json', body: '{"phase":"approved","seen":"{{state.seen}}"}' },
    ] },
    { id: 'notify', method: 'POST', path: '/notify', rules: [{ id: 'n', status: 200, contentType: 'text', body: 'OK' }] },
    { id: 'pay', method: 'POST', path: '/pay', rules: [{ id: 'p', status: 200, contentType: 'html', body: '<h1>테스트 결제창</h1><p>외부 결제 요청 없음</p>' }] },
  ] } })
  assert.equal((await request(`${mockPath}/state`)).phase, 'pending')
  assert.equal((await request(`${mockPath}/state`)).phase, 'approved')
  ok('stateful / sequential HTTP Mock')

  const plain = await flow('basic', [node('set', 'set', { vars: [{ key: 'result', value: 'OK' }] }), node('assert', 'assert', { condition: "{{ result@set }} == 'OK'" })])
  assert.equal((await run(plain)).status, 'SUCCEEDED'); ok('SET / ASSERT / START / END')
  const branch = await flow('branch', [node('if', 'if', { condition: 'true' }), node('yes', 'assert', { condition: 'true' }), node('no', 'assert', { condition: 'false' })], [edge('start', 'if'), edge('if', 'yes', 'true'), edge('if', 'no', 'false'), edge('yes', 'end'), edge('no', 'end')])
  const br = await run(branch)
  assert.equal(br.status, 'SUCCEEDED'); assert.ok(!br.nodes.some((n: any) => n.nodeId === 'no' && n.status === 'FAILED')); ok('IF skips inactive branch')
  const sw = await flow('switch', [node('sw', 'switch', { switchActive: 'a', switchTracks: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }), node('yes', 'assert', { condition: 'true' }), node('no', 'assert', { condition: 'false' })], [edge('start', 'sw'), edge('sw', 'yes', 'a'), edge('sw', 'no', 'b'), edge('yes', 'end'), edge('no', 'end')])
  assert.equal((await run(sw)).status, 'SUCCEEDED'); ok('SWITCH selects active route')

  const input = await flow('input', [node('ask', 'input', { waitMsg: '실제 브라우저 입력 검증', waitFields: [{ key: 'amount', label: '금액', type: 'number' }, { key: 'payload', label: 'JSON', type: 'json' }] }), node('check', 'assert', { condition: '{{ amount@ask }} == 42' })])
  const ir = await run(input); assert.equal(ir.pendingInput.nodeId, 'ask')
  await request(`/api/v1/executions/${ir.id}/resume`, 'POST', { nodeId: 'ask', formValues: { amount: 42, payload: { ok: true } } })
  assert.equal((await settle(ir.id, true)).status, 'SUCCEEDED'); ok('INPUT pauses and resumes typed values')
  const cancel = await run(input)
  await request(`/api/v1/executions/${cancel.id}/resume`, 'POST', { nodeId: 'ask', aborted: true, error: 'test cancellation' })
  assert.equal((await settle(cancel.id, true)).status, 'CANCELLED'); ok('cancel pending execution')

  const client = await flow('client-http', [node('http', 'http', { reqMode: 'client', method: 'GET', baseUrl: internal, path: `${mockPath}/ping`, respType: 'json' }), node('check', 'assert', { condition: '{{ ok@http }} == true' })])
  const cr = await run(client); assert.equal(cr.pendingClient.nodeId, 'http')
  await request(`/api/v1/executions/${cr.id}/resume`, 'POST', { nodeId: 'http', status: 200, body: '{"ok":true}' })
  assert.equal((await settle(cr.id, true)).status, 'SUCCEEDED'); ok('client HTTP specification and resume')
  const form = await flow('form', [node('form', 'form', { formAction: `${internal}${mockPath}/pay`, formMethod: 'POST', formDisplay: 'iframe' })])
  const fr = await run(form); assert.equal(fr.pendingForm.method, 'POST')
  await request(`/api/v1/executions/${fr.id}/resume`, 'POST', { nodeId: 'form', popupOpened: true })
  assert.equal((await settle(fr.id, true)).status, 'SUCCEEDED'); ok('FORM specification and resume')

  const wait = await flow('wait', [node('wait', 'wait', { waitTimeoutSec: 30, callbackRespType: 'text', callbackRespBody: 'RECEIVED' }), node('check', 'assert', { condition: "{{ result@wait }} == 'OK'" })])
  const wr = await run(wait); assert.equal(wr.status, 'WAITING')
  const cbPath = new URL(wr.pendingWait.receiveUrl).pathname
  assert.equal(await request(cbPath, 'POST', { result: 'OK' }), 'RECEIVED')
  assert.equal((await settle(wr.id, true)).status, 'SUCCEEDED'); ok('WAIT receives external callback and resumes')
  const timed = await flow('timeout', [node('wait', 'wait', { waitTimeoutSec: 1, callbackRespType: 'text' })])
  const tr = await run(timed)
  let timeoutRun = tr
  for (let i = 0; i < 60 && timeoutRun.status === 'WAITING'; i++) { await sleep(250); timeoutRun = await settle(tr.id) }
  assert.equal(timeoutRun.status, 'FAILED'); ok('WAIT timeout without browser')

  const wh = await request(`/api/v1/flows/${plain}/triggers`, 'POST', { type: 'WEBHOOK' }, 201)
  triggersToDisable.push(`/api/v1/flows/${plain}/triggers/${wh.id}`)
  const fired = await request(`/hooks/${wh.webhookToken}`, 'POST', { value: 1 }, 202)
  assert.equal((await settle(fired.executionId)).status, 'SUCCEEDED')
  await request(`/api/v1/flows/${plain}/triggers/${wh.id}`, 'PUT', { enabled: false })
  await request(`/hooks/${wh.webhookToken}`, 'POST', {}, 404); ok('WEBHOOK fire / disabled token rejection')
  const schedule = await request(`/api/v1/flows/${plain}/triggers`, 'POST', { type: 'SCHEDULE', cron: '*/1 * * * * *' }, 201)
  triggersToDisable.push(`/api/v1/flows/${plain}/triggers/${schedule.id}`)
  let observed = false
  for (let i = 0; i < 110; i++) {
    const current = await request(`/api/v1/flows/${plain}/triggers`)
    if (current.some((t: any) => t.id === schedule.id && t.lastRunAt)) { observed = true; break }
    await sleep(250)
  }
  await request(`/api/v1/flows/${plain}/triggers/${schedule.id}`, 'PUT', { enabled: false })
  assert.ok(observed, 'scheduler actually fired'); ok('SCHEDULE actual scheduler fire')
  const suite = await request('/api/v1/suites/run', 'POST', { flowIds: [plain, branch, sw] })
  for (const item of suite) assert.equal((await settle(item.executionId)).status, 'SUCCEEDED')
  assert.equal(suite.length, 3); ok('suite runs three scenarios')

  await request('/api/v1/settings/notify', 'PUT', { value: `${internal}${mockPath}/notify` })
  const fail = await flow('failure-notification', [node('assert', 'assert', { condition: 'false' })])
  assert.equal((await run(fail)).status, 'FAILED')
  await sleep(300)
  const mocks = await request('/api/v1/mock-servers' + (workspaceId ? `?workspaceId=${workspaceId}` : ''))
  const mock = mocks.find((m: any) => m.slug === slug)
  const log = await request(`/api/v1/mock-servers/${mock.id}/requests`)
  assert.match(JSON.stringify(log), /notify/); ok('failure notification delivered to HTTP Mock')
} finally {
  // 실패한 검증이 있어도 모든 원상 복구를 시도하고, 생성한 트리거는 꺼 둔다.
  const restored = await Promise.allSettled([
    ...triggersToDisable.map(path => request(path, 'PUT', { enabled: false })),
    request('/api/v1/settings/notify', 'PUT', { value: previousNotify.value }),
    request('/api/v1/settings/relay', 'PUT', { value: previousRelay.value }),
  ])
  const failed = restored.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), '테스트 설정 복원 실패')
}

const outputDir = process.env.FLOWLINK_TEST_OUTPUT_DIR || '.run/agent-lab'
mkdirSync(resolve(repo, outputDir), { recursive: true })
const outputFile = resolve(repo, outputDir, `features-fixtures-${remote ? 'server' : 'local'}.json`)
writeFileSync(outputFile, JSON.stringify({ base, slug, checks, fixtures }, null, 2))
console.log(`ALL ${checks} PASS; UI fixtures saved in ${outputFile}`)
