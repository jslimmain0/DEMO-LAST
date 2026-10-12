// Actual node-setting handlers: IME, source preservation, read-only and save-before-test.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
let rendering, fields = [], focused, inputLabels = []
const react = {
  lazy: () => 'code-editor', Suspense: 'suspense',
  useState(initial) { const index = rendering.index++, slot = rendering.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value }] },
  useRef(initial) { return react.useMemo(() => ({ current: initial }), []) },
  useMemo(make, deps) { const index = rendering.index++; if (!rendering.slots[index] || !sameDeps(rendering.slots[index].deps, deps)) rendering.slots[index] = { value: make(), deps }; return rendering.slots[index].value },
  useEffect(effect, deps) { const index = rendering.index++, previous = rendering.slots[index]; if (!previous || !sameDeps(previous.deps, deps)) { const slot = rendering.slots[index] = { deps }; rendering.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() }) } },
}
const jsx = (type, props, key) => {
  if (props?.className === 'fl-node-input-fields') props.ref.current = { querySelectorAll: selector => selector === '[data-input-key]' ? fields.map(field => ({ dataset: { inputKey: field.id }, focus: () => { focused = field.id }, scrollIntoView() {} })) : inputLabels }
  return { type, props, key }
}
function renderer(component) {
  const state = { slots: [], effects: [], index: 0 }
  const render = () => { rendering = state; state.index = 0; state.effects = []; const tree = component(); rendering = null; state.effects.forEach(effect => effect()); return tree }
  render.unmount = () => state.slots.forEach(slot => slot.cleanup?.())
  return render
}
function walk(node, predicate, found = []) { if (Array.isArray(node)) node.forEach(child => walk(child, predicate, found)); else if (node && typeof node === 'object') { if (predicate(node)) found.push(node); walk(node.props?.children, predicate, found) } return found }
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : ''
const find = (tree, predicate) => walk(tree, predicate)[0]
const byLabel = (tree, label) => find(tree, node => node.props?.['aria-label'] === label)
const button = (tree, label) => find(tree, node => node.type === 'button' && text(node).trim() === label)
const enter = (composing = false) => ({ key: 'Enter', keyCode: composing ? 229 : 13, nativeEvent: { isComposing: composing }, preventDefault() {} })
const saved = new Map(), notices = []
let id = 0, canEdit = true
function load(file, modules = {}, extra = '') {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8') + extra, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports, require: name => modules[name] ?? {}, localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) }, navigator: { clipboard: { writeText: async () => {} } }, setTimeout, clearTimeout, structuredClone })
  return exports
}
const grammar = load('lib/tokenGrammar.ts'), bulk = load('lib/bulkPaste.ts')
const modules = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../design/ui': { ui: {} }, '../lib/ids': { newId: () => `field-${++id}` }, '../lib/bulkPaste': bulk, '../lib/tokenGrammar': grammar, '../components/toast': { toast: message => notices.push(message) } }
modules['../lib/bodyConvert'] = load('lib/bodyConvert.ts')
let node = { id: 'http', type: 'http', method: 'POST', bodyType: 'json', jsonRaw: true, rawBody: '{"name":"처음"}', baseUrl: 'https://api.test', path: '/orders', fields: { params: [], headers: [], body: [] }, outputs: [] }
const updates = [], order = [], apiRuns = []
const inputVariables = { orderId: '처음 입력' }
const structureChanges = []
let preparation, failSave = false
const store = { flowId: 'flow', selectedId: 'http', edges: [], dirty: true, readOnly: false, nodes: [{ id: 'http', data: node }], updateNodeData: (nodeId, patch) => { updates.push({ nodeId, patch }); node = { ...node, ...patch }; store.nodes = [{ id: node.id, data: node }]; store.dirty = true }, getGraph: () => ({ nodes: [{ ...node }], edges: [] }), markSaved: () => { store.dirty = false }, deleteNode: () => structureChanges.push('delete'), selectNode() {}, removeEdge() {}, duplicateSelection: () => structureChanges.push('duplicate'), focusNode() {} }
const useEditorStore = selector => selector(store); useEditorStore.getState = () => store
const api = { runsApi: { runNode: async (_flow, _node, body) => { order.push('run'); apiRuns.push(body); return { ok: true, output: { name: '최신 결과' } } }, listForFlow: async () => [] }, flowsApi: { saveVersion: async (_flow, body) => { order.push('save'); if (failSave) throw Error('저장 실패'); assert.equal(body.graph.nodes[0].rawBody, node.rawBody); return { versionNo: 7 } } }, environmentsApi: { list: async () => [] }, secretsApi: { list: async () => [] } }
const scope = { current: { origin: 'local', id: 'pc' }, scopeKey: 'local:pc', connected: true, resourceIdentity: { serverUrl: 'https://company.test', login: 'alice' } }
Object.assign(modules, {
  '../app/WorkspaceContext': { useApi: () => api, useWorkspace: () => scope },
  '../lib/frontendMock': { FRONTEND_MOCK: true }, '../auth/AuthContext': { usePermissions: () => ({ canEdit }) },
  '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries() {} }), useQuery: () => ({ data: [], isSuccess: true }) }, axios: { isAxiosError: () => false },
  '../canvas/graphAdapter': { asGraphNode: value => value }, '../canvas/nodeMeta': { typeLabel: type => type, METHOD_COLOR: {}, catColor: () => 'black' },
  '../lib/environments': { useEnvironment: () => ({ prepareForRun: async () => { order.push('prepare'); await preparation }, activeEnvVars: () => ({}), activeEnvName: () => '개발', activeEnvSource: () => 'local' }), useEnvStore: () => ({ active: '개발', envs: { 개발: {} } }) },
  '../lib/runInput': { useRunInput: () => inputVariables, useRunInputActions: () => ({ activeInputVars: () => ({ ...inputVariables }) }) }, '../store/editorStore': { useEditorStore }, '../lib/reachable': { computeReachInfo: () => ({}), isUnreachableExecutable: () => false },
  '../binding/upstream': { bindableSources: () => [] }, '../binding/TokenInput': { TokenInput: 'token-input' },
  './KeyValueEditor': { KeyValueEditor: 'key-value' },
  '../lib/useTransformCatalog': { useTransformCatalog: () => ({ query: { data: [] } }) },
  '../components/AgentSettings': { useNodeResources: () => ({ api, agent: 'local', workspaceId: 'pc', environmentKey: [], key: [], available: true, crossBoundary: false }), usesOwnerResources: () => true, isBrowserRequest: () => false },
  '../lib/useAgentEnvironmentBindings': { useAgentEnvironmentBindings: () => ({ save: async () => ({}), bindings: {} }) }, '../lib/agentEnvironments': load('lib/agentEnvironments.ts'),
  '../lib/presence': { presence: { sendSaved() {} } }, '../lib/appBase': { appUrl: value => value },
})
const property = load('panels/PropertyPanel.tsx', modules, '\nexport { WaitFieldsEditor, OutputsEditor, VarsEditor, ConditionEditor };')
const fieldEditor = load('panels/KeyValueEditor.tsx', modules)
async function run() {
  const renderPanel = renderer(() => property.PropertyPanel({ modal: true, width: '100%' }))
  let tree = renderPanel()
  assert.equal(button(tree, '본문 (•)').props['aria-pressed'], true, 'POST starts at the body tab')
  const rawCode = find(tree, node => node.type === 'code-editor')
  rawCode.props.onChange('{"name":"최신 입력","number":42}'); tree = renderPanel()
  button(byLabel(tree, '바디 입력 방식'), '필드').props.onClick(); tree = renderPanel()
  assert.equal(node.fields.body.find(field => field.key === 'number').type, 'number', 'raw-to-field keeps numeric types')
  button(byLabel(tree, '바디 입력 방식'), 'Raw').props.onClick(); tree = renderPanel()
  assert.equal(JSON.parse(node.rawBody).number, 42, 'field-to-raw keeps numeric values')
  const latestRaw = node.rawBody
  button(tree, '헤더').props.onClick(); tree = renderPanel()
  assert.equal(button(tree, '헤더').props['aria-pressed'], true)
  button(tree, '본문 (•)').props.onClick(); tree = renderPanel()
  assert.equal(find(tree, node => node.type === 'code-editor').props.value, latestRaw, 'tab changes preserve latest authoring input')
  byLabel(tree, '메서드').props.onChange({ target: { value: 'GET' } }); tree = renderPanel()
  assert.equal(button(tree, '쿼리').props['aria-pressed'], true)
  assert.equal(node.rawBody, latestRaw, 'GET hides but never erases prior body')
  byLabel(tree, '메서드').props.onChange({ target: { value: 'POST' } }); tree = renderPanel()
  assert.equal(button(tree, '본문 (•)').props['aria-pressed'], true)
  let release
  preparation = new Promise(resolve => { release = resolve })
  const runButton = button(tree, '이 노드 테스트')
  const first = runButton.props.onClick(), duplicateRun = runButton.props.onClick()
  assert.deepEqual(order, ['prepare'], 'rapid duplicate test waits share one operation')
  inputVariables.orderId = '준비 중 수정한 최신 입력'
  release(); await first; await duplicateRun
  assert.deepEqual(order, ['prepare', 'save', 'run'])
  assert.equal(apiRuns[0].versionNo, 7)
  assert.equal(apiRuns[0].input.orderId, '준비 중 수정한 최신 입력', 'single-node tests send the latest workflow input just like full runs')
  assert.equal(apiRuns[0].envSource, 'local')
  assert.equal(apiRuns[0].resourceWorkspaceId, 'public')
  assert.equal(JSON.stringify(apiRuns[0].resourceIdentity), JSON.stringify(scope.resourceIdentity), 'single test captures the selected server account for local runtime validation')
  assert.equal(JSON.stringify(apiRuns[0].env), '{}', 'single-node tests explicitly send an empty PC environment snapshot')
  tree = renderPanel(); assert.match(text(tree), /성공/)
  find(tree, element => element.type === 'code-editor').props.onChange('{"name":"테스트 이후 변경"}'); tree = renderPanel()
  assert.match(text(tree), /테스트 후 설정이 바뀌었습니다/)
  store.dirty = true; failSave = true; order.length = 0
  await button(tree, '이 노드 테스트').props.onClick(); tree = renderPanel()
  assert.deepEqual(order, ['prepare', 'save'], 'failed save prevents API execution')
  assert.match(text(tree), /저장 실패/)
  failSave = false
  canEdit = false; tree = renderPanel(); const before = updates.length
  byLabel(tree, '노드 이름').props.onChange({ target: { value: '권한 없이 수정' } })
  assert.equal(updates.length, before, 'panel callback independently guards existing permission')
  assert.equal(byLabel(tree, '노드 이름').props.readOnly, true)
  assert.equal(byLabel(tree, '메서드').props.disabled, true)
  assert.ok(walk(tree, element => element.type === 'token-input').every(element => element.props.readOnly))
  assert.equal(button(tree, '이 노드 테스트'), undefined)
  assert.equal(button(tree, '복제').props.disabled, true)
  button(tree, '복제').props.onClick(); button(tree, '삭제').props.onClick()
  assert.equal(structureChanges.length, 0, 'global read-only cannot duplicate/delete through property handlers')
  renderPanel.unmount()
  canEdit = true
  node = { ...node, jsonRaw: false, fields: { params: [], headers: [], body: [{ id: 'number', key: 'customer.age', value: '42', type: 'number' }, { id: 'bool', key: 'active', value: 'false', type: 'boolean' }] } }; store.nodes = [{ id: node.id, data: node }]
  const renderDocked = renderer(() => property.PropertyPanel({ modal: false, width: 360 }))
  tree = renderDocked(); assert.equal(walk(tree, element => element.type === 'button' && text(element) === '이 노드 테스트').length, 1)
  assert.equal(button(tree, '▶ 이 노드만 실행'), undefined, 'single test action is not duplicated in collapsed tools')
  find(tree, element => element.type === 'button' && text(element).includes('요청 미리보기')).props.onClick(); tree = renderDocked()
  const requestPreview = find(tree, element => element.type === 'pre' && typeof element.props.children === 'string' && element.props.children.startsWith('POST ')).props.children
  assert.deepEqual(JSON.parse(requestPreview.split('\n\n')[1]), { customer: { age: 42 }, active: false }, 'request preview respects nested paths and JSON value types')
  renderDocked.unmount()

  fields = [{ id: 'otp', key: 'otp', type: 'string', label: '인증번호' }]
  let fieldReadOnly = false
  const renderFields = renderer(() => property.WaitFieldsEditor({ fields, readOnly: fieldReadOnly, onChange: next => { fields = next } }))
  inputLabels = [{ dataset: { inputLabel: 'otp' }, focus: () => { focused = 'label-otp' } }]
  tree = renderFields()
  byLabel(tree, '입력 키 1').props.onKeyDown(enter(true)); assert.equal(focused, undefined); assert.equal(fields.length, 1)
  byLabel(tree, '입력 키 1').props.onKeyDown(enter()); assert.equal(focused, 'label-otp'); assert.equal(fields.length, 1)
  byLabel(tree, '입력 표시 이름 1').props.onKeyDown(enter(true)); assert.equal(fields.length, 1)
  byLabel(tree, '입력 표시 이름 1').props.onKeyDown(enter()); tree = renderFields()
  assert.equal(fields.length, 2); assert.equal(focused, fields[1].id, 'new field focuses its key')
  byLabel(tree, '입력 키 2').props.onChange({ target: { value: 'otp' } }); tree = renderFields(); assert.match(text(tree), /중복된 출력 키/)
  fieldReadOnly = true; tree = renderFields(); const previousFields = fields
  byLabel(tree, '입력 키 1').props.onChange({ target: { value: '수정 불가' } }); button(tree, '+ 입력 필드').props.onClick()
  assert.equal(fields, previousFields); assert.equal(byLabel(tree, '입력 타입 1').props.disabled, true)
  renderFields.unmount()
  let rowUpdates = 0
  const renderReadOnlyRows = renderer(() => fieldEditor.KeyValueEditor({ rows: [{ id: 'key', key: 'name', value: '값' }], sources: [], readOnly: true, onChange: () => { rowUpdates++ } }))
  tree = renderReadOnlyRows(); button(tree, '+ 필드').props.onClick(); byLabel(tree, '1번째 필드 키').props.onChange({ target: { value: '수정 불가' } })
  assert.equal(rowUpdates, 0); assert.equal(find(tree, element => element.type === 'token-input').props.readOnly, true)
  renderReadOnlyRows.unmount()
  let helperChanges = 0
  const readonlyOutputs = renderer(() => property.OutputsEditor({ outputs: [{ key: 'result', type: 'string' }], readOnly: true, onChange: () => { helperChanges++ } }))
  tree = readonlyOutputs(); byLabel(tree, '출력 키 1').props.onChange({ target: { value: '수정 불가' } }); button(tree, '+ 출력 항목').props.onClick()
  assert.equal(helperChanges, 0); assert.equal(byLabel(tree, '출력 타입 1').props.disabled, true); readonlyOutputs.unmount()
  const readonlyVars = renderer(() => property.VarsEditor({ vars: [{ id: 'var', key: 'key', value: '값' }], sources: [], sourceType: () => null, readOnly: true, onChange: () => { helperChanges++ } }))
  tree = readonlyVars(); const varInput = find(tree, element => element.type === 'token-input')
  varInput.props.onChange('수정 불가'); button(tree, '+ 변수 추가').props.onClick()
  assert.equal(varInput.props.readOnly, true); assert.equal(helperChanges, 0); readonlyVars.unmount()
  const readonlyCondition = property.ConditionEditor({ label: '조건', ariaLabel: '조건', value: 'true', sources: [], readOnly: true, onChange: () => { helperChanges++ } })
  const conditionInput = find(readonlyCondition, element => element.type === 'token-input')
  conditionInput.props.onChange('false'); assert.equal(conditionInput.props.readOnly, true); assert.equal(helperChanges, 0)
  console.log('PASS: actual HTTP body tabs preserve input, save precedes single test, duplicate/failure guards hold, read-only reaches panel/native/token controls')
  console.log('PASS: actual INPUT Enter advances labels/rows, IME adds nothing, new keys focus, duplicate keys warn and read-only blocks edits')
  console.log('PASS: condition, output and variable editors inherit read-only and block source changes independently')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
