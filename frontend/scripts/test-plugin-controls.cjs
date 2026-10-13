// Render the real plugin workbench and exercise controls without browser/network/MCP.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const detail = { id: 'plugin', name: '긴 이름의 플러그인', source: 'const plugin = {}', pluginId: 'long-plugin-identifier', kind: 'transform', status: 'PENDING', live: true, liveSource: 'const plugin = { old: true }', usages: 0 }
const scope = { current: { origin: 'local', id: 'pc' }, remoteKey: 'company:alice:true', connected: true, workspaces: [{ origin: 'server', id: 'public', myRole: 'OWNER' }] }
const states = [], refs = [], effects = [], mutations = [], mutationOptions = [], notices = []
let stateIndex = 0, refIndex = 0, permitted = true, admin = true, narrow = true, routeId = 'plugin', detailError = false, savePending = false
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
      useQuery: options => options.queryKey.at(-1) === 'usages' ? { data: usageRefs } : options.queryKey[2] === routeId ? { data: routeId === detail.id ? detail : undefined, isLoading: routeId !== detail.id && !detailError, isError: detailError, error: new Error('조회 실패'), refetch() {} } : ({ data: options.queryKey[0] === 'admin' ? { admin } : options.queryKey[1] === 'api' ? [] : [detail] }),
      useQueryClient: () => ({ invalidateQueries() {} }), useMutation: options => { const index = mutationOptions.push(options) - 1; return { isPending: index === 0 && savePending, mutate: value => mutations.push(value ?? 'save'), ...options } },
    },
    'react-router-dom': { useParams: () => ({ id: routeId }), useSearchParams: () => [new URLSearchParams()], useNavigate: () => to => navigations.push(to) },
    '../app/WorkspaceContext': { useCentralApi: () => ({ adminApi: {}, pluginsApi: {} }), useWorkspace: () => scope },
    '../components/UnsavedNavigation': { useUnsavedNavigation: () => ({ navigateSaved() {} }) },
    '../components/useEscapeClose': { registerEscapeClose: () => () => {} },
    '../components/toast': { toast: (message, kind) => notices.push({ message, kind }) }, '../lib/apiError': { apiErrorMessage: error => error.message },
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
function render() { stateIndex = refIndex = 0; effects.length = mutationOptions.length = 0; return exported.CentralPlugins() }
const button = (tree, label) => walk(tree, node => node.type === 'button' && text(node).trim() === label)[0]
let tree = render()
effects.find(effect => String(effect).includes('setDraft({ id: d.id'))()
tree = render()
let group = walk(tree, node => node.props?.['aria-label'] === '플러그인 작업')[0]
assert.ok(group, 'mutation actions remain in an accessible header group after wrapping layout')
assert.deepEqual(walk(group, node => node.type === 'button').map(text).map(value => value.trim()), ['승인본과 비교', '저장', '테스트 패널', 'API 참고', '철회', '✓ 승인', '반려', '삭제'])
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
const beforePanelOpen = mutations.length
button(tree, '테스트 패널').props.onClick(); tree = render()
assert.equal(button(tree, '테스트 패널').props['aria-expanded'], true)
assert.equal(mutations.length, beforePanelOpen, 'opening test inputs never saves, approves or executes the plugin')
assert.ok(button(walk(tree, node => node.props?.['aria-label'] === '플러그인 작업')[0], '테스트 패널'), 'test panel access stays with the selected plugin actions')
walk(tree, node => node.props?.['aria-label'] === '보조 패널 닫기')[0].props.onClick(); tree = render()
assert.equal(button(tree, '테스트 패널').props['aria-expanded'], false, 'closing support restores code without losing reopen control')
savePending = true; tree = render()
for (const label of ['저장 중…', '철회', '✓ 승인', '반려', '삭제']) assert.equal(button(tree, label).props.disabled, true, `saving blocks concurrent ${label}`)
savePending = false
detail.status = 'DRAFT'; detail.live = false; permitted = false; admin = false
tree = render(); group = walk(tree, node => node.props?.['aria-label'] === '플러그인 작업')[0]
assert.deepEqual(walk(group, node => node.type === 'button').map(text), ['테스트 패널', 'API 참고'], 'viewer can discover support panels while mutation actions stay unavailable')
assert.equal(walk(tree, node => node.type === 'code-editor')[0].props.readOnly, true)
console.log('PASS: pending/live admin action handlers and confirmations survive wrapping; narrow list/support can close and reopen; viewer remains read-only')
permitted = admin = true
tree = render()
walk(tree, node => node.props?.['aria-label'] === '플러그인 이름')[0].props.onChange({ target: { value: '변경한 초안' } })
tree = render()
assert.equal(button(tree, '승인 요청').props.disabled, true, 'approval stays discoverable while saving is required')
assert.match(button(tree, '승인 요청').props.title, /먼저 저장/)
const saveOptions = mutationOptions[0], transitionOptions = mutationOptions[1]
const selected = saveOptions.onMutate()
saveOptions.onError(new Error('문법 오류'), undefined, selected)
tree = render()
assert.match(text(walk(tree, node => node.props?.role === 'alert')[0]), /문법 오류.*입력은 유지/)
assert.equal(walk(tree, node => node.type === 'code-editor')[0].props.value, detail.source)
detailError = true; tree = render()
assert.equal(walk(tree, node => node.type === 'code-editor').length, 1, 'background refresh failure preserves the current editor')
assert.ok(button(tree, '다시 불러오기'), 'saved-state fetch failures expose recovery next to the editor')
const oldSelected = transitionOptions.onMutate(), noticeCount = notices.length
routeId = 'other'; detailError = false; tree = render()
assert.equal(walk(tree, node => node.type === 'code-editor').length, 0, 'loading another plugin never exposes the old source as the new plugin')
transitionOptions.onSuccess(null, { op: 'approve', targetId: 'plugin' }, oldSelected)
transitionOptions.onError(new Error('이전 요청 실패'), { op: 'approve', targetId: 'plugin' }, oldSelected)
saveOptions.onError(new Error('이전 저장 실패'), undefined, selected)
assert.equal(notices.length, noticeCount, 'late mutations do not decorate another plugin')
detailError = true; tree = render()
assert.ok(button(tree, '다시 불러오기'), 'initial detail failures expose recovery instead of a generic empty page')
console.log('PASS: plugin save failures preserve source and show recovery; cached refresh errors stay editable; late mutation feedback and old drafts are isolated by selection')
routeId = 'plugin'; detailError = false
states.length = refs.length = 0
const renderUsages = () => { stateIndex = refIndex = 0; return exported.UsagesChip({ id: 'plugin', count: 3 }) }
tree = renderUsages()
walk(tree, node => node.type === 'button')[0].props.onClick()
tree = renderUsages()
const popup = walk(tree, node => node.props?.role === 'region' && node.props?.['aria-label'] === '플러그인 사용처')[0]
assert.ok(popup)
assert.equal(popup.props.onMouseLeave, undefined, 'the usage list stays open when the pointer moves between trigger and results')
assert.equal(walk(tree, node => node.type === 'button')[0].props['aria-expanded'], true)
const rows = walk(popup, node => node.type === 'button')
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
