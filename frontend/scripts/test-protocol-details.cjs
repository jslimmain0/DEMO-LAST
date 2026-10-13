// Real protocol/field/TCP panel controls and callbacks; no backend or MCP calls.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const jsx = (type, props) => ({ type, props })
let state
const react = {
  useState(initial) { const i = state.index++; if (!(i in state.values)) state.values[i] = typeof initial === 'function' ? initial() : initial; return [state.values[i], next => { state.values[i] = typeof next === 'function' ? next(state.values[i]) : next }] },
  useRef(initial) { const i = state.index++; return state.values[i] ??= { current: initial } },
  useMemo: make => make(), useEffect() {},
}
function renderer(component, props) {
  const own = { index: 0, values: [] }
  return () => { state = own; own.index = 0; return component(props) }
}
const walk = (node, predicate, out = []) => {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, out))
  else if (node && typeof node === 'object') { if (predicate(node)) out.push(node); walk(node.props?.children, predicate, out) }
  return out
}
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const byLabel = (tree, label) => walk(tree, node => node.props?.['aria-label'] === label)[0]
let mutation = { isPending: false }, previewCalls = []
const modules = {
  react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-router-dom': { useNavigate: () => () => {}, useSearchParams: () => [new URLSearchParams()] },
  '@tanstack/react-query': { useQuery: () => ({ data: [] }), useMutation: () => mutation },
  '../app/WorkspaceContext': { useWorkspace: () => ({ scopeKey: 'local:pc', current: { origin: 'local', id: 'pc' }, connected: true }), useCentralApi: () => ({ adminApi: {}, codecsApi: {}, protocolsApi: {} }) },
  '../auth/AuthContext': { useAuth: () => ({}) }, '../lib/environments': { useEnvironment: () => ({ activeEnvName: () => null, prepareForRun: async () => {} }), useEnvStore: () => ({ envs: {} }) },
  '../lib/apiError': { apiErrorMessage: error => error.message }, './UnsavedNavigation': { useUnsavedNavigation: () => ({ navigateSaved() {} }) },
  '../lib/format': { relTime: () => '' },
  '../design/ui': { ui: {} }, '../lib/vaultSources': { useVaultSources: () => [] }, '../binding/TokenInput': { TokenInput: 'token-input' },
}
function load(file) {
  const exported = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports: exported, require: name => modules[name] ?? {}, structuredClone, URLSearchParams, TextEncoder })
  return exported
}
modules['../lib/protocolSpec'] = load('lib/protocolSpec.ts')
const table = modules['./ProtocolFieldTable'] = load('components/ProtocolFieldTable.tsx')
const protocol = load('components/ProtocolEditor.tsx')
const tcp = load('panels/TcpNodePanel.tsx')
let fields = [{ name: 'same', len: 4, type: 'ascii' }, { name: 'same', len: 4, type: 'ascii' }, { name: '', len: 0, type: 'ascii' }]
const tableProps = { get fields() { return fields }, onChange: next => { fields = next }, baseOffset: 0, codecs: [], readOnly: false }
const renderTable = renderer(table.FieldTable, tableProps)
let tree = renderTable()
assert.equal(byLabel(tree, '필드 1 이름').props['aria-invalid'], true)
assert.equal(byLabel(tree, '필드 3 이름').props['aria-invalid'], true)
assert.equal(byLabel(tree, '필드 3 길이').props.value, '')
assert.match(text(tree), /중복된 이름입니다/)
assert.match(text(tree), /필드 이름을 입력하세요/)
assert.match(text(tree), /1 B 이상의 정수를 입력하세요/)
assert.equal(byLabel(tree, '필드 1 이름').props.style.boxSizing, 'border-box')
assert.equal(walk(tree, node => node.props?.role === 'region')[0].props.tabIndex, 0)
fields = [{ name: '필드2', len: 4, type: 'ascii' }]
tableProps.reservedNames = ['필드3']
tree = renderTable()
walk(tree, node => node.type === 'button' && text(node) === '+ 문자 필드')[0].props.onClick()
assert.equal(fields.at(-1).name, '필드4', 'new names avoid existing fields and the header names')
byLabel(renderTable(), '필드 1 길이').props.onChange({ target: { value: '' } })
assert.equal(fields[0].len, 0)
assert.equal(byLabel(renderTable(), '필드 1 길이').props.value, '', 'an empty edit is not forced to the visible text 0')

const fieldRow = value => tcp.FieldRow({ f: { name: 'bytes', len: 2, type: 'binary' }, offset: 0, value, encoding: 'UTF-8', sources: [], canEdit: true, onChange() {} })
assert.match(text(fieldRow('0A:FF')), /2\/2 B/)
assert.doesNotMatch(text(fieldRow('0A:FF')), /초과/)
assert.match(text(fieldRow('0A F')), /HEX 두 자리/)
assert.match(text(fieldRow('0A FF 01')), /3\/2 B 초과/)
assert.match(text(fieldRow('0A FF 01')), /조립·전송이 차단/)
assert.match(text(fieldRow('{{ data }}')), /\?\/2 B/)
assert.match(text(tcp.PreviewBox({ p: { total: 2, text: 'ok', hex: '4F 4B', fields: [], errors: [], warnings: ['초과분 잘림'] } })), /초과분 잘림/)

const spec = { encoding: 'UTF-8', lengthField: '', header: [], messages: [{ key: 'request', fields: [{ name: 'value', len: 4, type: 'ascii' }] }], framing: { mode: 'fixed', fixedLength: 4 } }
const renderEditor = renderer(protocol.ProtocolEditor, { detail: { id: 'wire', name: 'wire', spec }, canEdit: true, onSaved() {} })
tree = renderEditor()
assert.equal(tree.props.style.minWidth, 0)
assert.ok(walk(tree, node => node.props?.style?.gridTemplateColumns === 'minmax(0, 1fr)').length, 'field table width is contained by the editor grid')
const previewNode = walk(tree, node => typeof node.type === 'function' && node.type.name === 'PreviewSection')[0]
mutation = { isPending: false, mutate: signature => previewCalls.push(signature) }
const renderPreview = renderer(previewNode.type, previewNode.props)
tree = renderPreview()
let prevented = 0
walk(tree, node => node.type === 'form')[0].props.onSubmit({ preventDefault: () => prevented++ })
assert.equal(prevented, 1)
assert.equal(previewCalls.length, 1)
byLabel(tree, 'value 값').props.onChange({ target: { value: 'PING' } })
tree = renderPreview()
assert.equal(byLabel(tree, 'value 값').props.value, 'PING')
walk(tree, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} })
mutation.isError = true; mutation.error = new Error('미리보기 실패'); mutation.variables = previewCalls.at(-1)
assert.match(text(renderPreview()), /미리보기 실패/)
byLabel(renderPreview(), 'value 값').props.onChange({ target: { value: 'PONG' } })
tree = renderPreview()
assert.equal(byLabel(tree, 'value 값').props.value, 'PONG')
assert.doesNotMatch(text(tree), /미리보기 실패/, 'editing invalidates an earlier error without discarding the new value')
mutation.data = { signature: previewCalls.at(-1), result: { total: 4, errors: [], warnings: [], fields: [], text: 'PING', hex: '50 49 4E 47' } }
assert.match(text(renderPreview()), /다시 조립해 최신 결과/)
console.log('PASS: narrow protocol grid contains field scroll; explicit field errors and unique names; actual binary byte counts; Enter preview preserves edits and invalidates stale feedback')
