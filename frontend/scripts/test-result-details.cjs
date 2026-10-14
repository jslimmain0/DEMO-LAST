// Actual result components and handlers; synthetic masked data only, no backend or clipboard access.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { test } = require('node:test')
const jsx = (type, props, key) => ({ type, props, key })
const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]))
let rendering
const react = {
  useState(initial) {
    const frame = rendering, index = frame.index++
    const slot = frame.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
    return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
  },
  useRef(initial) { const [value] = react.useState(() => ({ current: initial })); return value },
  useEffect(effect, deps) {
    const frame = rendering, index = frame.index++, old = frame.slots[index]
    if (!old || !same(old.deps, deps)) frame.pending.push(() => {
      old?.cleanup?.(); frame.slots[index] = { deps, setup: effect, cleanup: effect() }
    })
  },
}
function renderer(component) {
  const frame = { slots: [], index: 0, pending: [] }
  const render = () => { rendering = frame; frame.index = 0; frame.pending = []; const value = component(); rendering = null; frame.pending.forEach(effect => effect()); return value }
  render.unmount = () => frame.slots.forEach(slot => slot.cleanup?.())
  render.strictReplay = () => { frame.slots.forEach(slot => slot.cleanup?.()); frame.slots.forEach(slot => { if (slot.setup) slot.cleanup = slot.setup() }) }
  return render
}
function walk(node, match, rows = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, match, rows))
  else if (node && typeof node === 'object') { if (match(node)) rows.push(node); walk(node.props?.children, match, rows) }
  return rows
}
function text(node) { return Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '' }
function load(file, modules, context = {}, extra = '') {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8') + extra, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports, AbortController, Date, Error, setTimeout, setInterval: () => 1, clearInterval() {}, require: name => modules[name] ?? {}, ...context })
  return exports
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const basics = { react, 'react/jsx-runtime': { jsx, jsxs: jsx } }

test('result body preserves raw masked text, supports keyboard scrolling and line wrapping choice', () => {
  const { LogBlock } = load('components/NodeExecutionLog.tsx', basics)
  const body = 'REQ1    A001\nAuthorization: ***\n' + 'x'.repeat(6000)
  const render = renderer(() => LogBlock({ title: '요청', text: body }))
  let tree = render()
  const pre = () => walk(tree, node => node.type === 'pre')[0]
  assert.equal(pre().props.children, body)
  assert.equal(pre().props.tabIndex, 0)
  assert.equal(pre().props['aria-label'], '요청 본문')
  const wrap = walk(tree, node => node.props?.['aria-label'] === '요청 본문 줄바꿈')[0]
  assert.equal(wrap.props['aria-pressed'], true)
  wrap.props.onClick(); tree = render()
  assert.equal(pre().props.style.whiteSpace, 'pre')
  assert.equal(pre().props.children, body, 'view preference never alters request/response bytes or masking')
})

test('result copy confirms only actual success and explains denied or missing clipboard access', async () => {
  const copied = [], notices = [], navigator = { clipboard: { writeText: async value => copied.push(value) } }
  const { LogBlock } = load('components/NodeExecutionLog.tsx', { ...basics, './toast': { toast: (...args) => notices.push(args) } }, { navigator })
  const render = renderer(() => LogBlock({ title: '응답', text: 'RES1***' }))
  const copy = () => walk(render(), node => node.props?.['aria-label'] === '응답 복사')[0].props.onClick()
  copy(); await new Promise(setImmediate)
  assert.deepEqual(copied, ['RES1***']); assert.equal(notices.at(-1)[1], 'ok')
  navigator.clipboard.writeText = async () => { throw new Error('Denied') }
  copy(); await new Promise(setImmediate)
  assert.equal(notices.at(-1)[1], 'error'); assert.match(notices.at(-1)[0], /직접 선택/)
  navigator.clipboard = undefined
  copy(); await new Promise(setImmediate)
  assert.equal(notices.at(-1)[1], 'error')
})

test('callback test rejects duplicate submission, keeps HTTP recovery feedback and stops at deadline', async () => {
  let calls = 0, now = 1000, next = deferred(), tick
  const date = class extends Date { static now() { return now } }
  const { WaitBanner } = load('panels/RunPanel.tsx', basics, { Date: date, setInterval: fn => { tick = fn; return 1 }, fetch: () => { calls++; return next.promise } }, '\nexport { WaitBanner };')
  const render = renderer(() => WaitBanner({ status: { nodeId: 'wait', receiveUrl: 'https://test.invalid/relay/cb', deadline: 5000 } }))
  let tree = render()
  const send = walk(tree, node => node.type === 'button' && text(node) === '보내기')[0].props.onClick
  const first = send(), second = send()
  assert.equal(calls, 1)
  assert.equal(walk(render(), node => node.props?.['aria-label'] === '테스트 콜백 본문')[0].props.disabled, true, 'pending callback freezes the exact submitted body')
  next.resolve({ ok: false, status: 503 }); await Promise.all([first, second]); tree = render()
  assert.match(text(tree), /HTTP 503/); assert.match(text(tree), /다시 보내기/)
  assert.equal(walk(tree, node => node.props?.role === 'alert').length, 1)
  next = deferred(); const retry = walk(tree, node => node.type === 'button' && text(node) === '다시 보내기')[0].props.onClick()
  next.resolve({ ok: true }); await retry; tree = render(); assert.match(text(tree), /전달 완료/)
  const delivered = walk(tree, node => node.type === 'button' && text(node).includes('전달 완료'))[0]
  assert.equal(delivered.props.disabled, true); await delivered.props.onClick(); assert.equal(calls, 2, 'completed callback is not sent again on a second click')
  now = 6000; tick(); tree = render(); assert.match(text(tree), /기한 종료/)
  const finished = walk(tree, node => node.type === 'button' && text(node).includes('전달 완료'))[0]
  assert.equal(finished.props.disabled, true); await finished.props.onClick(); assert.equal(calls, 2)
  render.unmount()
})

test('leaving a wait node aborts its pending callback and isolates old response feedback', async () => {
  const next = deferred(), notices = []; let signal
  const { WaitBanner, RunPanel } = load('panels/RunPanel.tsx', { ...basics, '../components/toast': { toast: value => notices.push(value) } }, { fetch: (_url, options) => { signal = options.signal; return next.promise } }, '\nexport { WaitBanner };')
  const status = { nodeId: 'wait1', receiveUrl: '/relay/a', deadline: Date.now() + 5000 }
  const render = renderer(() => WaitBanner({ status }))
  const send = walk(render(), node => node.type === 'button' && text(node) === '보내기')[0].props.onClick()
  render.unmount(); assert.equal(signal.aborted, true)
  next.resolve({ ok: false, status: 500 }); await send; assert.deepEqual(notices, [])
  const panel = renderer(() => RunPanel({ execution: { id: 'run', status: 'WAITING', nodes: [] }, running: true, waitStatus: status, onClose() {} }))
  const firstKey = walk(panel(), node => node.type === WaitBanner)[0].key
  status.nodeId = 'wait2'; status.receiveUrl = '/relay/b'
  assert.notEqual(walk(panel(), node => node.type === WaitBanner)[0].key, firstKey, 'a new callback target mounts a new banner')
})

test('history caches and async rerun feedback respect runtime scope and open the returned result', () => {
  const queries = [], mutations = [], notices = []
  const scope = { scopeKey: 'server:public', current: { id: 'public', origin: 'server', myRole: 'OWNER' }, workspaces: [], select() {} }
  const modules = { ...basics,
    '../app/WorkspaceContext': { useWorkspace: () => scope, useApi: () => ({ runsApi: {} }) },
    '../components/toast': { toast: value => notices.push(value) }, '../lib/apiError': { apiErrorMessage: error => error.message }, '../design/ui': { ui: {} },
    '@tanstack/react-query': { useQuery: options => { queries.push(options); return { data: [], refetch() {} } }, useQueryClient: () => ({ invalidateQueries() {} }), useMutation: options => { mutations.push(options); return { isPending: false } } },
  }
  const { Executions, ExecutionDetailModal } = load('routes/Executions.tsx', modules, {}, '\nexport { ExecutionDetailModal };')
  const render = renderer(Executions)
  render(); render.strictReplay(); const rerun = mutations.at(-1)
  assert.equal(queries[0].queryKey.at(-1), 'server:public')
  rerun.onSuccess({ id: 'new-result' }, { scopeKey: 'server:public' })
  assert.equal(walk(render(), node => node.type === ExecutionDetailModal)[0].props.execId, 'new-result')
  scope.scopeKey = 'local:pc'; scope.current.origin = 'local'; render()
  const count = notices.length
  rerun.onSuccess({ id: 'wrong-result' }, { scopeKey: 'server:public' })
  rerun.onError({ message: 'old-server-error' }, { scopeKey: 'server:public' })
  assert.equal(notices.length, count); assert.equal(walk(render(), node => node.type === ExecutionDetailModal).length, 0)
  mutations.at(-1).onError({ message: '서버 권한 거부' }, { scopeKey: 'local:pc' })
  assert.match(text(render()), /서버 권한 거부/); assert.match(text(render()), /이력 새로고침/)
})

test('detail scopes queries, preserves TCP bodies, and distinguishes comparison or cancellation failures from empty history', () => {
  let retried = 0; const queries = [], mutations = [], notices = []
  const current = { id: 'current', flowId: 'flow', status: 'WAITING', startedAt: '2026-10-14T10:00:00Z', pendingAgent: { nodeId: 'tcp', agent: 'server', status: 'UNKNOWN' }, nodes: [{ id: 'node', nodeId: 'tcp', nodeName: 'TCP 전문', status: 'SUCCEEDED', requestText: 'REQ1MASKED***', responseText: 'RES1MASK', output: { result: 'MASK' } }] }
  const modules = { ...basics,
    '../app/WorkspaceContext': { useWorkspace: () => ({ scopeKey: 'server:public', current: { myRole: 'OWNER' } }), useApi: () => ({ runsApi: {} }) },
    '../components/toast': { toast: value => notices.push(value) }, '../lib/apiError': { apiErrorMessage: error => error?.message ?? '오류' }, '../design/ui': { ui: {} },
    '../components/NodeExecutionLog': { LogBlock: 'log', outputText: node => JSON.stringify(node.output) },
    '@tanstack/react-query': {
      useQuery: options => { queries.push(options); return options.queryKey[0] === 'exec-flow-runs' ? { isError: true, error: { message: '비교 권한 거부' }, refetch: () => { retried++ } } : { data: options.queryKey[1] === 'current' ? current : null, refetch() {} } },
      useMutation: options => { mutations.push(options); return { isPending: false, mutate() {} } },
    },
  }
  const { ExecutionDetailModal } = load('routes/Executions.tsx', modules, {}, '\nexport { ExecutionDetailModal };')
  const render = renderer(() => ExecutionDetailModal({ execId: 'current', onClose() {} }))
  let tree = render()
  assert.ok(queries.every(query => query.queryKey.at(-1) === 'server:public'))
  assert.equal(queries.find(query => query.queryKey[0] === 'execution' && query.queryKey[1] !== 'current').enabled, false)
  walk(tree, node => node.type === 'button' && text(node) === 'TCP 전문')[0].props.onClick(); tree = render()
  const logs = walk(tree, node => node.type === 'log')
  assert.equal(logs.find(log => log.props.title === '요청').props.text, 'REQ1MASKED***')
  assert.equal(logs.find(log => log.props.title === '응답').props.text, 'RES1MASK')
  walk(tree, node => node.type === 'button' && text(node) === '이전 실행과 비교')[0].props.onClick(); tree = render()
  assert.match(text(tree), /비교 권한 거부/); assert.doesNotMatch(text(tree), /비교할 이전 실행이 없습니다/)
  walk(tree, node => node.type === 'button' && text(node) === '비교 다시 시도')[0].props.onClick(); assert.equal(retried, 1)
  mutations.at(-1).onError({ message: '서버 중단 거부' }); tree = render()
  assert.match(text(tree), /서버 중단 거부/)
  const count = notices.length, oldCancel = mutations.at(-1)
  render.unmount(); oldCancel.onError({ message: '이전 창 응답' }); assert.equal(notices.length, count)
})

test('UNKNOWN shows preserved masked response and TCP phases without rerunning or resuming the request', () => {
  let requests = 0, retries = 0
  const transfer = load('components/TcpTransferSteps.tsx', basics)
  const { RunPanel } = load('panels/RunPanel.tsx', { ...basics,
    '../components/TcpTransferSteps': transfer,
    '../components/NodeExecutionLog': { LogBlock: 'log', outputText: node => JSON.stringify(node.output) },
  }, { fetch() { requests++; throw new Error('display must not send a request') } })
  const steps = [{ phase: 'RESPONSE', role: 'client', direction: 'RECEIVE', status: 'SUCCEEDED', actualBytes: 8, expectedBytes: 8, durationMs: 2 },
    { phase: 'RESPONSE_ACK', role: 'client', direction: 'RECEIVE', status: 'FAILED', actualBytes: null, expectedBytes: 1, durationMs: null, validationMode: 'exact', errorCode: 'ACK_TIMEOUT' }]
  const current = { id: 'uncertain', status: 'WAITING', nodes: [], pendingAgent: { nodeId: 'tcp', nodeName: '결제', agent: 'local', status: 'UNKNOWN', diagnostics: { responseFields: { resultCode: '00', token: '***' }, _tcpTransport: { transportStatus: 'UNKNOWN', steps, protocolFingerprint: 'safe-plan-hash' } } } }
  const render = renderer(() => RunPanel({ execution: current, running: false, onClose() {}, onRetry() { retries++ } }))
  let tree = render()
  assert.match(text(tree), /자동으로 재실행하지 않습니다/)
  assert.match(text(tree), /전체 처리가 완료됐다고 판단할 수 없습니다/)
  const phaseView = walk(tree, node => node.type === transfer.TcpTransferSteps)[0]
  const phaseTree = transfer.TcpTransferSteps(phaseView.props)
  assert.match(text(phaseTree), /응답 ACK실패/)
  assert.match(text(phaseTree), /ACK_TIMEOUT/)
  const response = walk(tree, node => node.type === 'log' && node.props.title === '이미 받은 응답')[0]
  assert.deepEqual(JSON.parse(response.props.text), { resultCode: '00', token: '***' })
  render(); render.strictReplay(); render()
  assert.equal(requests, 0); assert.equal(retries, 0, 'rendering and effect replay cannot retry an uncertain payment')
  assert.equal(current.pendingAgent.status, 'UNKNOWN')
  current.pendingAgent = null
  current.nodes = [{ id: 'tcp-result', nodeId: 'tcp', nodeName: '결제', status: 'SUCCEEDED', outputJson: JSON.stringify({ _tcpTransport: { steps } }) }]
  tree = render()
  walk(tree, node => node.type === 'button' && node.props['aria-expanded'] === false)[0].props.onClick()
  tree = render()
  assert.equal(walk(tree, node => node.type === transfer.TcpTransferSteps)[0].props.steps.length, 2, 'saved transport metadata has the same phase view')
})
