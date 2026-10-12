// Actual Mock route + protocol editor trees; preserves production PC restrictions.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
let mock = true, origin = 'local', workspaceCalls = 0
let searchParams = new URLSearchParams()
const effects = [], stateChanges = [], navigations = []
const listeners = new Map()
const jsx = (type, props) => ({ type, props })
const codecs = [{ id: 'central-field', label: '공통 필드 코덱', layer: 'field', params: [] }, { id: 'central-message', label: '공통 메시지 코덱', layer: 'message', params: [] }]
const modules = {
  react: { useMemo: make => make(), useEffect: effect => effects.push(effect), useRef: initial => ({ current: initial }), useState: initial => { const current = typeof initial === 'function' ? initial() : initial; return [current, next => stateChanges.push(typeof next === 'function' ? next(current) : next)] } },
  'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-router-dom': { useNavigate: () => () => {}, useSearchParams: () => [searchParams] },
  '@tanstack/react-query': { useQuery: config => ({ data: config.queryKey[0] === 'codecs' ? codecs : {} }), useMutation: () => ({ isPending: false }) },
  '../app/WorkspaceContext': { useWorkspace: () => { workspaceCalls++; return { current: { origin, id: 'pc' }, connected: true, remoteKey: 'central' } }, useApi: () => ({ mocksApi: {} }), useCentralApi: () => ({ adminApi: {}, codecsApi: {}, protocolsApi: {} }) },
  '../lib/frontendMock': { get FRONTEND_MOCK() { return mock } }, '../auth/AuthContext': { useAuth: () => ({ isGuest: false }) },
  './AssistantLoginGate': {}, './ProtocolAssistantPanel': {}, './AskDialog': {}, './Modal': {}, './ResourceScopeNote': { ResourceScopeNote: 'scope-note' },
  './UnsavedNavigation': { useUnsavedNavigation: () => ({ navigateSaved: to => navigations.push(to) }) }, './toast': {},
  '../lib/apiError': {}, '../lib/format': { relTime: () => '' }, '../lib/environments': {}, '../lib/vaultSources': {},
  './AppIcon': { AppIcon: 'icon' }, '../binding/BindingPicker': {}, '../binding/TokenInput': { TokenInput: 'token-input' },
  '../canvas/nodeMeta': { METHOD_COLOR: {} }, '../lib/tokenGrammar': {}, '../lib/ids': {},
  './BigTextEditor': {}, './FieldCodecButton': {}, './icons': {}, './MockCodecEditor': {}, '../design/ui': { ui: {} },
}
function load(file) {
  const exported = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports: exported, structuredClone, URLSearchParams, window: { addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener() {} }, require: name => { if (!(name in modules)) throw new Error(`Missing fixture: ${name}`); return modules[name] } })
  return exported
}
modules['../lib/mockSources'] = load('lib/mockSources.ts')
modules['../lib/mockCodecOps'] = load('lib/mockCodecOps.ts')
modules['../lib/protocolSpec'] = load('lib/protocolSpec.ts')
const fieldTable = modules['./ProtocolFieldTable'] = load('components/ProtocolFieldTable.tsx')
const { ProtocolEditor } = load('components/ProtocolEditor.tsx')
const { RouteCard } = load('components/MockRouteEditor.tsx')
function walk(node, predicate, result = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, result))
  else if (node && typeof node === 'object') { if (predicate(node)) result.push(node); walk(node.props?.children, predicate, result) }
  return result
}
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : ''
const field = { name: 'code', type: 'string', len: 4 }
const detail = { id: 'wire', name: '공통 전문', spec: { encoding: 'UTF-8', header: [field], messages: [{ key: 'request', fields: [{ ...field, name: 'amount' }] }], messagePlugins: [] } }
for (const [mode, location, allowed] of [[true, 'local', true], [false, 'local', true], [false, 'server', true]]) {
  mock = mode; origin = location
  const before = workspaceCalls, changes = []
  const routeTree = RouteCard({ base: 'http://localhost', mockId: 'mock', spec: {}, route: { id: 'route', method: 'GET', path: '/', rules: [] }, secrets: [], ensureSaved: async () => true, onChange: route => changes.push(route) })
  assert.equal(workspaceCalls, before + 1, 'Mock route workspace hook is unconditional')
  assert.equal(walk(routeTree, node => node.props?.['aria-label'] === '코덱 요약').length, Number(allowed))
  const toggle = walk(routeTree, node => node.type === 'label' && text(node).includes('이 라우트만 코덱'))[0]
  assert.equal(!!toggle, allowed)
  if (allowed) {
    walk(toggle, node => node.type === 'input')[0].props.onChange({ target: { checked: true } })
    assert.equal(JSON.stringify(changes[0].codec), '{}', 'per-route central codec can be enabled')
  }
  const protocolTree = ProtocolEditor({ detail, canEdit: true, onSaved() {} })
  const tables = walk(protocolTree, node => node.type === fieldTable.FieldTable)
  assert.equal(tables.length, 2)
  for (const table of tables) {
    assert.equal(table.props.pluginsAllowed, allowed)
    const nativeTable = table.type(table.props)
    assert.equal(walk(nativeTable, node => node.type === 'button' && node.props['aria-label'] === '필드 1 플러그인').length, Number(allowed), 'header and message field codec controls follow the selected mode')
  }
  const message = walk(protocolTree, node => typeof node.type === 'function' && node.type.name === 'MessagePlugins')[0]
  assert.equal(!!message, allowed)
  if (allowed) {
    const chooser = walk(message.type(message.props), node => node.type === 'select' && node.props['aria-label'] === '플러그인 추가')[0]
    assert.ok(chooser)
    assert.equal(walk(chooser, node => node.type === 'option' && node.props.value === 'central-message').length, 1, 'central message catalog is reachable on a local route')
  }
}
console.log('PASS: local/server Mock and production expose shared route, header-field, message-field and message codecs')

searchParams = new URLSearchParams('add=0210')
effects.length = stateChanges.length = navigations.length = 0
const readOnly = ProtocolEditor({ detail, canEdit: false, onSaved() {} })
effects.find(effect => String(effect).includes("searchParams.get('add')"))()
assert.equal(stateChanges.length, 0, 'read-only deep links cannot create a message or mark the protocol unsaved')
assert.equal(navigations.length, 0, 'read-only add query remains inert')
for (const label of ['프로토콜 이름', '프로토콜 인코딩', '길이 필드', '길이 형식', '분기 필드']) {
  const control = walk(readOnly, node => node.props?.['aria-label'] === label)[0]
  assert.ok(control, `${label} has an explicit control label`)
  assert.equal(control.props.disabled, true, `${label} preserves read-only access`)
}
assert.equal(walk(readOnly, node => node.type === 'button' && text(node) === '저장').length, 0)
effects.length = stateChanges.length = 0
ProtocolEditor({ detail, canEdit: true, onSaved() {} })
effects.find(effect => String(effect).includes("searchParams.get('add')"))()
assert.ok(stateChanges.some(value => value?.messages?.some(message => message.key === '0210')), 'editable Mock-to-protocol links still add the requested message')
assert.equal(navigations.length, 1)
effects.find(effect => String(effect).includes('saveRef.current()'))()
let prevented = 0
const saveKey = { ctrlKey: true, code: 'KeyS', preventDefault: () => prevented++ }
listeners.get('keydown')({ ...saveKey, isComposing: true })
listeners.get('keydown')({ ...saveKey, keyCode: 229 })
assert.equal(prevented, 0, 'protocol save shortcut yields to unfinished Korean composition')
listeners.get('keydown')(saveKey)
assert.equal(prevented, 1, 'physical Ctrl+S remains available after composition completes')
console.log('PASS: protocol controls are named/read-only; add-message deep link respects editing permission and still works for editors')
