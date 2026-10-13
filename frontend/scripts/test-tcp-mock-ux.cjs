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
      '../binding/TokenInput': { TokenInput: 'token-input' }, '../panels/TcpNodePanel': { FieldRow: 'field-row', PreviewBox: 'preview' },
      '../lib/apiError': { apiErrorMessage: error => error.message }, '../design/ui': { ui: {} }, './toast': {}, '../lib/format': {},
    })[name] ?? {},
  })
  const spec = { encoding: 'US-ASCII', header: [], discriminator: '', messages: [{ key: 'request', fields: [{ name: 'value', len: 4, type: 'ascii' }] }, { key: 'response', fields: [{ name: 'value', len: 4, type: 'ascii' }] }], framing: { mode: 'fixed', fixedLength: 4 }, transport: { idleTimeoutMs: 60000 } }
  return { ...exported, requests, invalidations, result, saved, spec, query,
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
