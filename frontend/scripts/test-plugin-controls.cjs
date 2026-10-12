// Render the real plugin workbench and exercise controls without browser/network/MCP.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const detail = { id: 'plugin', name: '긴 이름의 플러그인', source: 'const plugin = {}', pluginId: 'long-plugin-identifier', kind: 'transform', status: 'PENDING', live: true, liveSource: 'const plugin = { old: true }', usages: 0 }
const scope = { current: { origin: 'local', id: 'pc' }, remoteKey: 'company:alice:true', connected: true, workspaces: [{ origin: 'server', id: 'public', myRole: 'OWNER' }] }
const states = [], refs = [], effects = [], mutations = []
let stateIndex = 0, refIndex = 0, permitted = true, admin = true, narrow = true
const jsx = (type, props, key) => ({ type, props, key })
const navigations = [], usageRefs = [{ kind: 'flow', id: '', name: '접근 권한 없는 워크플로' }, { kind: 'flow', id: '', name: '접근 권한 없는 워크플로' }, { kind: 'mock', id: 'allowed', name: '읽을 수 있는 Mock' }]
const exported = {}
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/routes/Plugins.tsx'), 'utf8') + '\nexport { CentralPlugins, UsagesChip };', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
vm.runInNewContext(code, {
  exports: exported, structuredClone,
  localStorage: { getItem: () => null, setItem() {} },
  window: { matchMedia: () => ({ matches: narrow }), addEventListener() {}, removeEventListener() {} },
  require: name => ({
    react: {
      lazy: () => 'code-editor', Suspense: 'suspense', useDeferredValue: value => value,
      useCallback: callback => callback, useMemo: callback => callback(), useEffect: callback => effects.push(callback),
      useRef: initial => { const index = refIndex++; return refs[index] ?? (refs[index] = { current: initial }) },
      useState: initial => { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '@tanstack/react-query': {
      useQuery: options => ({ data: options.queryKey.at(-1) === 'usages' ? usageRefs : options.queryKey[0] === 'admin' ? { admin } : options.queryKey[2] === 'plugin' ? detail : options.queryKey[1] === 'api' ? [] : [detail] }),
      useQueryClient: () => ({ invalidateQueries() {} }), useMutation: options => ({ isPending: false, mutate: value => mutations.push(value ?? 'save'), ...options }),
    },
    'react-router-dom': { useParams: () => ({ id: 'plugin' }), useSearchParams: () => [new URLSearchParams()], useNavigate: () => to => navigations.push(to) },
    '../app/WorkspaceContext': { useCentralApi: () => ({ adminApi: {}, pluginsApi: {} }), useWorkspace: () => scope },
    '../components/UnsavedNavigation': { useUnsavedNavigation: () => ({ navigateSaved() {} }) },
    '../auth/AuthContext': { usePermissions: () => ({ canEdit: permitted }) },
    '../app/AppShell': { AppShellTier1: 'shell' }, '../components/AppIcon': { AppIcon: 'icon' },
    '../components/PluginRunPanel': { PluginRunPanel: 'run-panel' }, '../components/AskDialog': { AskDialog: 'ask' },
    '../components/PluginDiffView': { PluginDiffView: 'diff' }, '../components/PluginReference': { PluginReference: 'reference' },
    '../lib/pluginCompletions': { flCompletionSource() {}, declaredKeysSource() {} },
    '../lib/pluginTemplates': { PLUGIN_TEMPLATES: { transform: { label: '변환' } }, PLUGIN_EXAMPLES: [], kindLabel: () => '변환' },
    '../lib/frontendMock': { FRONTEND_MOCK: true }, '../lib/format': { relTime: value => value }, '../design/ui': { ui: {} },
  })[name] ?? {},
  URLSearchParams,
})
function walk(node, predicate, found = []) { if (Array.isArray(node)) node.forEach(child => walk(child, predicate, found)); else if (node && typeof node === 'object') { if (predicate(node)) found.push(node); walk(node.props?.children, predicate, found) } return found }
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : ''
function render() { stateIndex = refIndex = 0; effects.length = 0; return exported.CentralPlugins() }
const button = (tree, label) => walk(tree, node => node.type === 'button' && text(node).trim() === label)[0]
let tree = render()
effects.find(effect => String(effect).includes('setDraft({ id: d.id'))()
tree = render()
let group = walk(tree, node => node.props?.['aria-label'] === '플러그인 작업')[0]
assert.ok(group, 'mutation actions remain in an accessible header group after wrapping layout')
assert.deepEqual(walk(group, node => node.type === 'button').map(text).map(value => value.trim()), ['승인본과 비교', '저장', '철회', '✓ 승인', '반려', '삭제'])
button(group, '✓ 승인').props.onClick(); button(group, '철회').props.onClick()
assert.equal(mutations[0].op, 'approve'); assert.equal(mutations[1].op, 'withdraw')
button(group, '반려').props.onClick(); tree = render()
let ask = walk(tree, node => node.type === 'ask')[0]
assert.equal(ask.props.spec.confirmLabel, '반려'); ask.props.spec.onConfirm('수정 필요')
assert.equal(mutations.at(-1).note, '수정 필요')
button(tree, '삭제').props.onClick(); tree = render()
ask = walk(tree, node => node.type === 'ask')[0]
assert.equal(ask.props.spec.danger, true, 'wrapped delete button still asks before deleting')
assert.match(ask.props.spec.message, /서빙이 중단/)
button(tree, '승인본과 비교').props.onClick(); tree = render()
assert.equal(walk(tree, node => node.type === 'diff').length, 1)
button(tree, '편집으로').props.onClick(); tree = render()
assert.equal(walk(tree, node => node.type === 'code-editor').length, 1)
assert.equal(button(tree, '플러그인 목록').props['aria-expanded'], false, 'narrow workbench starts with code visible')
button(tree, '플러그인 목록').props.onClick(); tree = render()
assert.equal(button(tree, '목록 접기').props['aria-expanded'], true)
button(tree, '목록 접기').props.onClick(); tree = render()
button(tree, '테스트 실행').props.onClick(); tree = render()
assert.equal(button(tree, '테스트 실행').props['aria-expanded'], true)
walk(tree, node => node.props?.['aria-label'] === '보조 패널 닫기')[0].props.onClick(); tree = render()
assert.equal(button(tree, '테스트 실행').props['aria-expanded'], false, 'closing support restores code without losing reopen control')
detail.status = 'DRAFT'; detail.live = false; permitted = false; admin = false
tree = render(); group = walk(tree, node => node.props?.['aria-label'] === '플러그인 작업')[0]
assert.equal(walk(group, node => node.type === 'button').length, 0, 'layout preserves read-only mutation permissions')
assert.equal(walk(tree, node => node.type === 'code-editor')[0].props.readOnly, true)
console.log('PASS: pending/live admin action handlers and confirmations survive wrapping; narrow list/support can close and reopen; viewer remains read-only')
states.length = refs.length = 0
const renderUsages = () => { stateIndex = refIndex = 0; return exported.UsagesChip({ id: 'plugin', count: 3 }) }
tree = renderUsages()
walk(tree, node => node.type === 'button')[0].props.onClick()
tree = renderUsages()
const rows = walk(walk(tree, node => node.props?.role === 'menu')[0], node => node.type === 'button')
assert.equal(rows.length, 3)
assert.equal(new Set(rows.map(row => row.key)).size, 3, 'redacted empty IDs still receive distinct React keys')
for (const row of rows.slice(0, 2)) {
  assert.equal(row.props.disabled, true)
  assert.match(text(row), /접근 권한 없는 워크플로/)
  row.props.onClick()
}
assert.equal(navigations.length, 0, 'redacted references never navigate to an empty resource URL')
rows[2].props.onClick()
assert.equal(navigations[0], '/mocks/allowed')
console.log('PASS: redacted plugin usages remain counted and labeled, use unique keys, and cannot navigate')
