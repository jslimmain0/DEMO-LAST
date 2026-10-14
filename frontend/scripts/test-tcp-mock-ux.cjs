const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const plain = value => JSON.parse(JSON.stringify(value))
const source = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
function walk(node, predicate, out = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, out))
  else if (node && typeof node === 'object') { if (predicate(node)) out.push(node); walk(node.props?.children, predicate, out) }
  return out
}
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const control = (tree, label) => walk(tree, node => node.props?.['aria-label'] === label || node.props?.ariaLabel === label)[0]
function fixture() {
  let index = 0, mutation, pending = false
  const query = { data: [] }
  const hooks = [], effects = [], requests = [], invalidations = []
  const result = deferred(), saved = deferred()
  const jsx = (type, props) => typeof type === 'function' ? type(props) : ({ type, props })
  const exported = {}, helpers = {}
  vm.runInNewContext(compile(source('lib/protocolSpec.ts')), { exports: helpers, TextEncoder })
  const transfer = {}, nodePanel = {}
  vm.runInNewContext(compile(source('components/TcpTransferSteps.tsx')), { exports: transfer, require: name => name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : {} })
  vm.runInNewContext(compile(source('panels/TcpNodePanel.tsx')), { exports: nodePanel, require: name => ({
    '../design/ui': { ui: {} }, '../lib/protocolSpec': helpers, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-router-dom': { Link: 'link' },
    '../binding/TokenInput': { TokenInput: 'token-input' },
    '../components/AgentSettings': { useNodeResources: () => ({ available: true, key: ['public'], api: { protocolsApi: { list() {} } } }) },
    '../app/WorkspaceContext': { useWorkspace: () => ({ current: { origin: 'local', id: 'local' } }) },
    '@tanstack/react-query': { useQuery: options => options.queryKey.includes('protocol') ? { data: { spec }, isSuccess: true } : { data: [{ id: 'protocol', name: 'test' }], isSuccess: true } },
  })[name] ?? {} })
  const api = { tcpSend: (id, body) => { requests.push({ id, body: plain(body) }); return result.promise } }
  vm.runInNewContext(compile(source('components/TcpMockEditor.tsx')), {
    exports: exported,
    require: name => ({
      react: {
        useMemo: make => make(),
        useRef: initial => { const i = index++; return hooks[i] ??= { current: initial } },
        useState: initial => { const i = index++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], next => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next }] },
        useEffect: effect => { const i = index++; if (!(i in hooks)) { hooks[i] = true; effects.push(effect()) } },
      },
      'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-router-dom': { Link: 'link' },
      '../app/WorkspaceContext': { useApi: () => ({ mocksApi: api, protocolsApi: { list: () => [] } }) },
      '@tanstack/react-query': { useQuery: () => query, useMutation: options => {
        mutation = options
        return { isPending: pending, mutate: () => { pending = true; return options.mutationFn() } }
      }, useQueryClient: () => ({ invalidateQueries: options => invalidations.push(plain(options.queryKey)) }) },
      '../lib/protocolSpec': helpers, '../lib/mockSources': { tcpMockSources: () => [] },
      '../binding/TokenInput': { TokenInput: 'token-input' }, '../panels/TcpNodePanel': { FieldRow: 'field-row', PreviewBox: 'preview', integerValueError: nodePanel.integerValueError }, './TcpTransferSteps': transfer,
      '../lib/apiError': { apiErrorMessage: error => error.message }, '../design/ui': { ui: {} }, './toast': {}, '../lib/format': { relTime: () => '방금' },
    })[name] ?? {},
  })
  const spec = { encoding: 'US-ASCII', header: [], discriminator: '', messages: [{ key: 'request', fields: [{ name: 'value', len: 4, type: 'ascii' }] }, { key: 'response', fields: [{ name: 'value', len: 4, type: 'ascii' }] }], framing: { mode: 'fixed', fixedLength: 4 }, transport: { idleTimeoutMs: 60000 } }
  return { ...exported, ...nodePanel, ...transfer, requests, invalidations, result, saved, spec, query,
    render: component => { index = 0; return component() },
    send: () => { index = 0; return exported.TcpSendPanel({ mockId: 'mock', spec, ensureSaved: () => saved.promise }) },
    get mutation() { return mutation },
    finish: () => { pending = false; mutation.onSettled?.() },
    unmount: () => effects.forEach(cleanup => cleanup?.()),
  }
}

test('TCP Mock rule read-only protects condition and response token inputs, including keyboard access', () => {
  const f = fixture()
  const tree = f.render(() => f.TcpRuleDetail({ rule: { id: 'rule', when: [{ field: 'value', op: 'eq', value: 'A001' }], then: { mode: 'mock', fields: { value: 'B002' } } }, index: 0, total: 1, spec: f.spec, secrets: [], readOnly: true }))
  assert.equal(control(tree, '조건 1 값').props.readOnly, true)
  assert.equal(control(tree, 'value 값').props.readOnly, true)
  assert.doesNotMatch(text(tree), /▲|▼|복제|삭제/)
})

test('TCP connection preserves typed upstream whitespace and distinguishes saved versus draft addresses', () => {
  const f = fixture(), changes = []
  const tree = f.render(() => f.TcpConnPanel({ tcp: { protocolId: 'p', port: 19001 }, spec: f.spec, sources: [], address: '[::1]:19001', savedAddress: '[::1]:19000', onChange: patch => changes.push(plain(patch)) }))
  control(tree, 'upstream host:port').props.onChange('{{ TARGET@env }} ')
  assert.equal(changes[0].upstream, '{{ TARGET@env }} ')
  assert.match(text(tree), /기본 유휴시간.*60초/)
  assert.match(text(tree), /새 주소 · 저장 후 적용/)
  assert.match(text(tree), /현재 저장된 주소는.*\[::1\]:19000/)
  assert.equal(control(tree, '프로토콜').props.style.minWidth, 0)
})

test('TCP log failure offers retry instead of showing an empty traffic history', () => {
  const f = fixture(); let retries = 0
  f.query.isError = true; f.query.error = new Error('서버 연결 실패'); f.query.refetch = () => { retries++ }
  const tree = f.render(() => f.TcpLogPanel({ mockId: 'mock' }))
  assert.match(text(tree), /전문 로그를 불러오지 못했습니다.*서버 연결 실패/)
  assert.doesNotMatch(text(tree), /아직 전문이 없습니다/)
  walk(tree, node => node.type === 'button' && text(node) === '다시 불러오기')[0].props.onClick()
  assert.equal(retries, 1)
  assert.equal(control(tree, '경고·오류 로그').props['aria-pressed'], false)
})

test('TCP send locks inputs, prevents rapid repeated sends and preserves prior result and draft on retry failure', async () => {
  const f = fixture()
  let tree = f.send()
  walk(tree, node => node.type === 'field-row')[0].props.onChange('A001')
  tree = f.send()
  const button = walk(tree, node => node.type === 'button')[0]
  const pending = button.props.onClick()
  button.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.requests.length, 0)
  tree = f.send()
  assert.equal(control(tree, '보낼 전문').props.disabled, true)
  assert.equal(walk(tree, node => node.type === 'field-row')[0].props.canEdit, false)
  f.saved.resolve(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.requests, [{ id: 'mock', body: { key: 'request', values: { value: 'A001' } } }])
  const response = { request: {}, elapsedMs: 12, response: { key: 'response', bytes: 4, partial: false, chunks: [], warnings: [], header: {}, body: { value: 'B002' }, text: 'B002', hex: '42 30 30 32' } }
  f.result.resolve(response)
  f.mutation.onSuccess(response); f.finish()
  tree = f.send()
  assert.match(text(tree), /B002/)
  f.mutation.onError(new Error('timeout'))
  tree = f.send()
  assert.match(text(tree), /timeout.*입력한 값은 유지됩니다/)
  assert.match(text(tree), /이전 전송 결과.*B002/)
  assert.equal(walk(tree, node => node.type === 'field-row')[0].props.value, 'A001')
  f.unmount()
  await pending
})

test('TCP send navigation while saving skips transmission and ignores late results', async () => {
  const f = fixture(); f.send()
  const pending = f.mutation.mutationFn()
  f.unmount(); f.saved.resolve(true)
  await assert.rejects(pending, /Mock이 변경/)
  assert.equal(f.requests.length, 0)
  f.mutation.onSuccess({ response: {} })
  f.mutation.onError(new Error('late error'))
  assert.equal(f.invalidations.length, 0)
})

function v2Spec(spec) {
  Object.assign(spec, { schemaVersion: 2, header: [{ name: 'code', len: 2, type: 'ascii' }, { name: 'tid', len: 9, type: 'ascii' }],
    messages: [{ key: 'bill:request', fields: [{ name: 'amount', len: 8, type: 'integer', endian: 'big', signed: false }] }, { key: 'bill:response', fields: [{ name: 'result', len: 2, type: 'ascii' }] }, { key: 'cancel:request', fields: [{ name: 'reason', len: 5, type: 'ascii' }] }, { key: 'cancel:response', fields: [{ name: 'cancelResult', len: 2, type: 'ascii' }] }],
    transactions: [{ key: 'bill', when: [{ field: 'code', op: 'eq', value: 'G1' }], requestMessage: 'bill:request', responseMessage: 'bill:response', requestAck: null, responseAck: { send: { kind: 'hex', hex: '00'.repeat(30) }, receive: { kind: 'length-only', lengthBytes: 30 }, timeoutMs: 1000 } }, { key: 'cancel', when: [{ field: 'code', op: 'eq', value: 'H1' }], requestMessage: 'cancel:request', responseMessage: 'cancel:response', requestAck: null, responseAck: null }] })
}

test('v2 TCP rule transaction selection preserves business conditions and uses its exact response layout', () => {
  const f = fixture(), updates = []; v2Spec(f.spec)
  const rule = { id: 'rule', when: [{ field: 'code', op: 'eq', value: 'G1' }, { field: 'amount', op: 'ne', value: '0' }], then: { mode: 'mock', fields: { result: '00' } } }
  const render = readOnly => f.render(() => f.TcpRuleDetail({ rule, index: 0, total: 1, spec: f.spec, secrets: [], readOnly, onChange: patch => updates.push(plain(patch)) }))
  let tree = render(false)
  assert.equal(control(tree, '규칙 대상 거래').props.value, 'bill')
  assert.equal(f.responseMessageOf(rule, f.spec).key, 'bill:response')
  assert.match(text(tree), /응답 ACK.*30 B 수신/)
  control(tree, '규칙 대상 거래').props.onChange({ target: { value: 'cancel' } })
  assert.deepEqual(updates[0], { when: [{ field: 'code', op: 'eq', value: 'H1' }, { field: 'amount', op: 'ne', value: '0' }] })
  tree = render(true)
  assert.equal(control(tree, '규칙 대상 거래').props.disabled, true)
  control(tree, '규칙 대상 거래').props.onChange({ target: { value: 'cancel' } })
  assert.equal(updates.length, 1, 'read-only also guards the transaction handler')
  rule.then.fields.code = 'G1'; tree = render(false)
  control(tree, 'code 값').props.onChange('')
  assert.deepEqual(updates[1].then.fields, { result: '00' }, 'clearing response header restores request echo instead of sending an empty header')
})

test('v2 send chooses transaction, preserves decimal strings and shows failed ACK after the business response', async () => {
  const f = fixture(); v2Spec(f.spec)
  let tree = f.send()
  assert.match(text(tree), /선택 거래 bill.*code=G1.*자동/)
  const integerInput = walk(tree, node => node.type === 'field-row' && node.props.f.name === 'amount')[0]
  integerInput.props.onChange('18446744073709551615')
  tree = f.send()
  const pending = f.mutation.mutationFn(); f.saved.resolve(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.requests[0], { id: 'mock', body: { key: 'bill:request', transactionKey: 'bill', values: { tid: '', amount: '18446744073709551615' } } })
  const response = { request: {}, elapsedMs: 15, transactionKey: 'bill', executionId: 'execution-12345', transportStatus: 'FAILED', warnings: ['재시작하면 이력이 사라집니다.'],
    error: { code: 'ACK_EOF', phase: 'RESPONSE_ACK', expectedBytes: 30, actualBytes: 1, repairHint: '기존 실행을 조회하세요.' },
    steps: [{ phase: 'REQUEST_ACK', status: 'SKIPPED', actualBytes: 0, role: 'client', durationMs: 0 }, { phase: 'RESPONSE', status: 'SUCCEEDED', actualBytes: 266, role: 'client', durationMs: 1 }, { phase: 'RESPONSE_ACK', status: 'FAILED', expectedBytes: 30, actualBytes: 1, role: 'client', durationMs: 2, errorCode: 'ACK_EOF' }],
    response: { key: 'bill:response', bytes: 266, partial: false, chunks: [], warnings: [], header: {}, body: { result: '00' }, text: 'BUSINESS OK', hex: '' } }
  f.result.resolve(response); await pending
  f.mutation.onSuccess(response); f.finish()
  tree = f.send()
  assert.match(text(tree), /전송 미완료.*응답 ACK.*ACK_EOF.*1 \/ 30 B/)
  assert.match(text(tree), /BUSINESS OK/)
  assert.match(text(tree), /재시작하면 이력이 사라집니다/)
  assert.match(text(tree), /실행 ID execution-12345/)
  const steps = control(tree, 'TCP 전송 단계')
  assert.match(text(steps), /요청 ACK생략.*응답완료.*응답 ACK실패/)
})

test('integer input counts fixed wire bytes and checks unsigned 8-byte bounds without Number conversion', () => {
  const f = fixture(), field = { name: 'amount', type: 'integer', len: 8, endian: 'big', signed: false }
  assert.equal(f.integerValueError(field, '18446744073709551615'), null)
  assert.match(f.integerValueError(field, '18446744073709551616'), /범위/)
  assert.match(f.integerValueError(field, '1.5'), /10진/)
  assert.match(f.integerValueError(field, '-1'), /범위/)
  assert.equal(f.integerValueError(field, '{{amount@start}}'), null)
})

test('v2 node message selection fills visible blanks, fixes header conditions and selects matching response outputs', () => {
  const f = fixture(), changes = []; v2Spec(f.spec)
  const node = { protocolId: 'protocol', tcpMessage: '', tcpValues: {}, tcpHost: '127.0.0.1', tcpPort: 19000 }
  const tree = f.render(() => f.TcpRequestPanel({ node, update: patch => changes.push(plain(patch)), sources: [], canEdit: true, preview: null, previewErr: null, onPreview() {} }))
  control(tree, '송신 전문').props.onChange({ target: { value: 'bill:request' } })
  assert.deepEqual(changes[0], { tcpMessage: 'bill:request', tcpValues: { code: 'G1', tid: '', amount: '' }, tcpResponseMessage: 'bill:response', outputs: [{ key: 'code', type: 'string' }, { key: 'tid', type: 'string' }, { key: 'result', type: 'string' }] })
  const selected = { ...node, ...changes[0] }
  const response = f.render(() => f.TcpResponsePanel({ node: selected, update() {}, canEdit: true }))
  assert.match(text(control(response, '거래 응답 전문')), /bill:response/)
  assert.equal(control(response, '응답 전문'), undefined, 'the declared transaction fixes the response layout')
})

test('ACK traffic exposes phase and partial bytes without offering a business rule draft', () => {
  const f = fixture()
  f.query.data = [{ at: '2026-10-14T00:00:00Z', dir: 'in', source: 'mock', key: 'bill', transactionKey: 'bill', phase: 'RESPONSE_ACK', status: 'FAILED', actualBytes: 1, expectedBytes: 30, errorCode: 'ACK_EOF', validationMode: 'length-only', durationMs: 12, fields: {}, text: 'partial', hex: '00', bytes: 1, chunks: null, ruleId: 'rule', note: null, level: 'error' }]
  let tree = f.render(() => f.TcpLogPanel({ mockId: 'mock', onMakeRule() {} }))
  assert.match(text(tree), /응답 ACK · 실패.*ACK_EOF.*1 \/ 30 B/)
  walk(tree, node => node.type === 'button' && node.props['aria-expanded'] === false)[0].props.onClick()
  tree = f.render(() => f.TcpLogPanel({ mockId: 'mock', onMakeRule() {} }))
  assert.match(text(tree), /길이만 수신/)
  assert.doesNotMatch(text(tree), /규칙 초안/)
})

const editorTree = ts.createSourceFile('MockServerEditor.tsx', source('routes/MockServerEditor.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function declaration(name) {
  let found
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(editorTree) === name) found = node; ts.forEachChild(node, visit) }
  visit(editorTree)
  return found
}
function expression(name, context) {
  const exports = {}
  vm.runInNewContext(compile(`exports.value = ${declaration(name).initializer.getText(editorTree)}`), { exports, ...context })
  return exports.value
}
test('Mock enable waits for saving, aborts after failed saving/navigation and reports confirmed success', async () => {
  const saved = deferred(), writes = [], notes = [], toasts = [], draftRef = { current: { id: 'mock' } }, activeRef = { current: true }
  const options = expression('toggle', { id: 'mock', detail: { data: { enabled: false, kind: 'TCP' } }, ensureSaved: () => saved.promise, activeRef, draftRef,
    mocksApi: { update: async (...args) => writes.push(plain(args)) }, useMutation: options => options,
    qc: { invalidateQueries() {} }, invalidate() {}, toast: text => toasts.push(text), setNote: note => notes.push(note), apiErrorMessage: error => error.message, toggleBusy: { current: true } })
  const pending = options.mutationFn()
  assert.equal(writes.length, 0)
  saved.resolve(true)
  const confirmed = await pending
  assert.deepEqual(writes, [['mock', { enabled: true }]])
  assert.equal(toasts.length, 0)
  options.onSuccess(confirmed)
  assert.match(toasts[0], /Mock을 켰습니다/)
  draftRef.current.id = 'other'
  await assert.rejects(options.mutationFn(), /Mock이 변경/)
  assert.equal(writes.length, 1)
  options.onError(new Error('old error'))
  assert.equal(notes.at(-1), null)
  draftRef.current.id = 'mock'; activeRef.current = false
  await assert.rejects(options.mutationFn(), /Mock이 변경/)
  const fail = expression('toggle', { id: 'mock', detail: { data: { enabled: false } }, ensureSaved: async () => false, useMutation: options => options })
  await assert.rejects(fail.mutationFn(), /저장하지 못해/)
})

test('Mock toggle rapid clicks stay single and stopping never saves an unfinished draft', async () => {
  let starts = 0
  const toggleBusy = { current: false }
  const toggleMock = expression('toggleMock', { toggleBusy, save: { isPending: false }, toggle: { mutate: () => { starts++ } } })
  toggleMock(); toggleMock()
  assert.equal(starts, 1)
  const writes = []
  const stop = expression('toggle', { id: 'mock', detail: { data: { enabled: true } }, ensureSaved: () => { throw new Error('must not save draft when stopping') },
    activeRef: { current: true }, draftRef: { current: { id: 'mock' } }, mocksApi: { update: async (...args) => writes.push(plain(args)) }, useMutation: options => options })
  await stop.mutationFn()
  assert.deepEqual(writes, [['mock', { enabled: false }]])
})

test('editing a TCP port never appends two ports; copy address stays saved and IPv6 is bracketed', () => {
  for (const [advertisedAddress, expectedHost] of [['10.20.30.40:19000', '10.20.30.40'], ['[::1]:19000', '[::1]'], ['::1:19000', '[::1]']]) {
    const exports = {}, context = { d: { listener: { advertisedAddress }, spec: { tcp: { port: 19000 } } }, spec: { tcp: { port: 19001 } } }
    const code = ['tcpHost', 'hostForAddress', 'tcpAddress', 'savedTcpAddress'].map(name => `const ${name} = ${declaration(name).initializer.getText(editorTree)};`).join('\n')
    vm.runInNewContext(compile(`${code}\nexports.draft = tcpAddress; exports.saved = savedTcpAddress`), { exports, ...context })
    assert.equal(exports.draft, `${expectedHost}:19001`)
    assert.equal(exports.saved, `${expectedHost}:19000`)
  }
})
