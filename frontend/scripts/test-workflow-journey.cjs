// Real workflow save/run callbacks and result panel; no browser, backend or MCP.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const src = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const editor = ts.createSourceFile('Editor.tsx', src('routes/Editor.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(node, predicate) {
  if (predicate(node)) return node
  let result
  ts.forEachChild(node, child => { if (!result) result = find(child, predicate) })
  return result
}
function expression(node, context) {
  const exported = {}
  const code = ts.transpileModule(`exports.value = ${node.getText(editor)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports: exported, ...context })
  return exported.value
}
const declaration = name => find(editor, n => ts.isVariableDeclaration(n) && n.name.getText(editor) === name)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))
function journeyFixture() {
  const store = { flowId: 'flow', dirty: true, nodes: [], setWaitingNode() {} }
  let graph = { name: 'A', nodes: [], edges: [] }, execution, running, runError
  const writes = [], starts = [], errors = [], pendingSaveRef = { current: null }, savedVersionRef = { current: { flowId: 'flow', version: 1 } }, stopRef = { current: null }
  const context = {
    structuredClone, AbortController, flowId: 'flow', canEdit: true, isCurrentEditor: () => store.flowId === 'flow',
    scope: { current: { origin: 'local' }, resourceIdentity: { serverUrl: 'https://company.test', login: 'alice' } },
    getGraph: () => graph, useEditorStore: { getState: () => store }, pendingSaveRef, savedVersionRef, stopRef,
    flowsApi: { saveVersion: (_id, { graph: snapshot }) => { const wait = deferred(); writes.push({ graph: snapshot, ...wait }); return wait.promise } },
    markSaved: () => { store.dirty = false }, presence: { sendSaved() {} }, setSaveConflict() {}, isAxiosError: () => false,
    toast: message => errors.push(message), useMutation: options => options,
    setShowLog() {}, setRunning: value => { running = value }, setExecution: value => { execution = value }, setRunError: value => { runError = value }, setWaitStatus() {},
    prepareForRun: async () => {}, activeEnvVars: () => ({}), activeInputVars: () => ({}), activeEnvName: () => '', activeEnvSource: () => 'local', FRONTEND_MOCK: true,
    runsApi: { run: async (id, body) => { starts.push({ id, body }); return { id: 'execution', flowId: id, status: 'SUCCEEDED', nodes: [] } } },
    inputResolverRef: { current: null }, setPendingInput() {},
  }
  const save = expression(declaration('save').initializer, context)
  context.save = { mutateAsync: async () => { try { const saved = await save.mutationFn(); save.onSuccess(saved); return saved } catch (error) { save.onError(error); throw error } } }
  const run = expression(declaration('executeRun').initializer, context)
  return {
    run, save: context.save, writes, starts, errors, store, pendingSaveRef, stopRef, savedVersionRef,
    edit(name) { graph = { ...graph, name }; store.dirty = true },
    get execution() { return execution }, get running() { return running }, get runError() { return runError },
  }
}
async function saveAndRun() {
  const f = journeyFixture()
  const first = f.save.mutateAsync(), duplicate = f.save.mutateAsync()
  assert.equal(f.writes.length, 1, 'rapid save calls share one version request')
  f.edit('B')
  const run = f.run()
  const doubleRun = f.run()
  await settle()
  assert.equal(f.writes.length, 1, 'run joins the outstanding save before saving the newer draft')
  assert.equal(f.starts.length, 0, 'execution must wait for saved version')
  f.writes[0].resolve({ versionNo: 2 })
  await Promise.all([first, duplicate]); await settle()
  assert.equal(f.store.dirty, true, 'older save does not clear the newer edit')
  assert.equal(f.writes.length, 2)
  assert.equal(f.writes[1].graph.name, 'B', 'run saves the latest draft after old save completes')
  f.writes[1].resolve({ versionNo: 3 })
  await Promise.all([run, doubleRun])
  assert.equal(f.starts.length, 1, 'rapid run calls start only one execution')
  assert.equal(f.starts[0].body.versionNo, 3)
  assert.equal(f.starts[0].body.envSource, 'local')
  assert.equal(f.starts[0].body.resourceWorkspaceId, 'public')
  assert.equal(f.starts[0].body.resourceIdentity.login, 'alice', 'local workflow run captures the current central account')
  assert.equal(JSON.stringify(f.starts[0].body.env), '{}', 'empty PC environment snapshot is explicit and cannot inherit server values')
  assert.equal(f.store.dirty, false)
  assert.equal(f.execution.status, 'SUCCEEDED')
  assert.equal(f.running, false)
  assert.equal(f.pendingSaveRef.current, null)
}
async function failureAndRetry() {
  const f = journeyFixture(), run = f.run()
  await settle(); f.writes[0].reject(new Error('저장 연결 실패')); await run
  assert.equal(f.starts.length, 0)
  assert.equal(f.runError.phase, 'preparing')
  assert.match(f.runError.message, /저장 연결 실패/)
  assert.equal(f.running, false)
  assert.equal(f.stopRef.current, null)
  assert.equal(f.pendingSaveRef.current, null, 'failed save releases the request guard')
  f.edit('수정')
  const retry = f.run(); await settle()
  assert.equal(f.runError, null, 'retry clears the prior preparation failure')
  f.writes[1].resolve({ versionNo: 2 }); await retry
  assert.equal(f.starts.length, 1)
  const g = journeyFixture(), changed = g.run(); await settle()
  g.edit('실행 계획 이후 변경'); g.writes[0].resolve({ versionNo: 2 }); await changed
  assert.equal(g.starts.length, 0, 'edits during final save require a fresh execution plan')
  assert.equal(g.store.dirty, true)
  assert.match(g.runError.message, /다시 확인/)
  const h = journeyFixture()
  h.store.dirty = false // a single-node test saved a newer version outside this Editor mutation
  h.savedVersionRef.current = { flowId: 'flow', version: 1 }
  await h.run()
  assert.equal(h.starts.length, 1)
  assert.equal(h.starts[0].body.versionNo, undefined, 'a clean full run uses the latest API version after another UI saved the graph')
}

const jsx = (type, props) => ({ type, props })
let rendering
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
const react = {
  useState(initial) {
    const index = rendering.index++, slot = rendering.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
    return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value }]
  },
  useRef(initial) { const [ref] = react.useState(() => ({ current: initial })); return ref },
  useEffect(effect, deps) {
    const index = rendering.index++, old = rendering.slots[index]
    if (!old || !sameDeps(old.deps, deps)) { rendering.slots[index] = { deps }; rendering.effects.push(effect) }
  },
}
function renderer(component) {
  const state = { slots: [], index: 0, effects: [] }
  return () => { rendering = state; state.index = 0; state.effects = []; const tree = component(); rendering = null; state.effects.forEach(effect => effect()); return tree }
}
function walk(node, predicate, result = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, result))
  else if (node && typeof node === 'object') { if (predicate(node)) result.push(node); walk(node.props?.children, predicate, result) }
  return result
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  return node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}
const button = (tree, label) => walk(tree, n => n.type === 'button' && text(n).trim() === label)[0]
let exportedBlob
const modules = {
  react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../components/StatusBadge': { StatusBadge: 'badge' }, '../components/MethodTag': { MethodTag: 'method' },
  '../lib/format': { duration: value => `${value}ms`, relTime: () => '이전' }, '../components/AgentSettings': { AgentBadge: 'agent' }, '../components/AppIcon': { AppIcon: 'icon' },
  './toast': { toast() {} }, '../components/toast': { toast() {} },
}
function load(file, extra = '') {
  const exported = {}
  const code = ts.transpileModule(src(file) + extra, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports: exported, Blob, URLSearchParams, URL: { createObjectURL: blob => { exportedBlob = blob; return 'blob:log' }, revokeObjectURL() {} }, window: { addEventListener() {}, removeEventListener() {} }, document: { createElement: () => ({ click() {} }) }, setTimeout() {}, require: name => { if (!(name in modules)) throw new Error(`Missing fixture ${name}`); return modules[name] } })
  return exported
}
const logs = load('components/NodeExecutionLog.tsx')
modules['../components/NodeExecutionLog'] = logs
modules['../components/TcpTransferSteps'] = load('components/TcpTransferSteps.tsx')
const { RunPanel } = load('panels/RunPanel.tsx')
async function resultsAndRecovery() {
  let props = {
    execution: { id: 'failed', status: 'FAILED', error: '응답 오류', nodes: [{ id: 'failed-node', nodeId: 'http', nodeName: 'API 호출', seq: 1, status: 'FAILED', nodeType: 'http', outputJson: '{"reason":"failed"}' }] },
    running: false, onClose() {}, onNodeSelect: id => { selected = id }, onRetry: () => { retried++ },
  }
  let selected, retried = 0
  const render = renderer(() => RunPanel(props))
  render(); let tree = render()
  assert.equal(walk(tree, node => node.type === logs.LogBlock && node.props.title === '출력')[0].props.text, '{"reason":"failed"}', 'outputJson-only node output is visible')
  button(tree, '노드 설정').props.onClick(); assert.equal(selected, 'http')
  button(tree, '다시 실행').props.onClick(); assert.equal(retried, 1)
  button(tree, '실패').props.onClick(); tree = render()
  assert.equal(button(tree, '실패').props['aria-pressed'], true)
  button(tree, '⬇ 내보내기').props.onClick(); assert.match(await exportedBlob.text(), /출력:\n\{"reason":"failed"\}/)
  props = { ...props, execution: { id: 'succeeded', status: 'SUCCEEDED', nodes: [{ id: 'success-node', nodeId: 'http', nodeName: 'API 호출', seq: 1, status: 'SUCCEEDED', output: { result: 'ok' } }] } }
  render(); tree = render()
  assert.equal(button(tree, '전체').props['aria-pressed'], true, 'a fresh run resets the previous failed filter')
  assert.match(text(tree), /API 호출/)
  props = { ...props, execution: null, requestError: '저장 연결 실패', errorPhase: 'preparing' }; tree = render()
  assert.match(text(tree), /실행을 준비하지 못했습니다/)
  assert.match(text(tree), /저장 연결 실패/)
  assert.doesNotMatch(text(tree), /아직 실행하지/)
  props = { ...props, errorPhase: 'tracking' }; tree = render()
  assert.match(text(tree), /요청이 처리됐을 수 있습니다/)
  assert.equal(logs.outputText({ output: false, outputJson: 'old' }), 'false', 'falsy parsed output is preserved')
  assert.equal(logs.outputText({ output: null, outputJson: 'raw' }), 'raw')
  const panel = find(editor, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(editor) === 'RunPanel')
  const retryExpression = panel.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(editor) === 'onRetry').initializer.expression
  const retry = () => {}
  for (const [phase, status, allowed] of [['preparing', null, true], ['tracking', null, false], ['tracking', 'WAITING', false], [null, 'FAILED', true]]) {
    const value = expression(retryExpression, { canEdit: true, running: false, runError: phase ? { phase } : null, execution: status ? { status } : null, onRun: retry })
    assert.equal(value === retry, allowed, `${phase}/${status} retry policy`)
  }
  const canvasSource = src('canvas/FlowCanvas.tsx')
  const canvas = ts.createSourceFile('FlowCanvas.tsx', canvasSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const testSettings = find(canvas, node => ts.isJsxElement(node) && node.getText(canvas).includes('이 노드 테스트 설정') && node.openingElement.tagName.getText(canvas) === 'button')
  const handler = testSettings.openingElement.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(canvas) === 'onClick').initializer.expression
  let expanded = 0, focused, menu = true
  const exported = {}
  const code = ts.transpileModule(`exports.open = ${handler.getText(canvas)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(code, { exports: exported, ctxMenu: { nodeId: 'http' }, useEditorStore: { getState: () => ({ focusNode: id => { focused = id } }) }, onExpandProps: () => { expanded++ }, setCtxMenu: value => { menu = value } })
  exported.open(); assert.equal(focused, 'http'); assert.equal(expanded, 1); assert.equal(menu, null)
  assert.doesNotMatch(canvasSource, /runNode\(/, 'context menu opens the normal test settings instead of sending an unsaved execution')
  const ariaDeclaration = find(canvas, node => ts.isVariableDeclaration(node) && node.name.getText(canvas) === 'canvasAriaLabels')
  const labels = {}, ariaCode = ts.transpileModule(`exports.value = ${ariaDeclaration.initializer.getText(canvas)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(ariaCode, { exports: labels })
  assert.equal(labels.value['controls.zoomIn.ariaLabel'], '확대')
  assert.equal(labels.value['controls.zoomOut.ariaLabel'], '축소')
  assert.equal(labels.value['controls.fitView.ariaLabel'], '전체 흐름 맞춤')
  assert.equal(labels.value['controls.interactive.ariaLabel'], '캔버스 편집 잠금 전환')
  const flow = find(canvas, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(canvas) === 'ReactFlow')
  assert.ok(flow.openingElement.attributes.properties.some(node => node.name?.getText(canvas) === 'ariaLabelConfig' && node.initializer.expression.getText(canvas) === 'canvasAriaLabels'), 'Korean labels are passed into the real ReactFlow controls')
  const modal = find(editor, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(editor) === 'Modal' && node.openingElement.attributes.properties.some(attr => attr.name?.getText(editor) === 'ariaLabel' && attr.initializer?.text === '노드 편집'))
  assert.ok(modal, 'node editor uses the common labeled Modal with focus, Escape and focus restoration')
  assert.ok(modal.getText(editor).includes('onCloseModal={() => setPropModal(false)}'), 'panel close uses the same shared dialog state')
}
async function historyOutputs() {
  const current = { id: 'current', flowId: 'flow', startedAt: '2026-10-12T14:30:00Z', status: 'SUCCEEDED', nodes: [{ id: 'current-node', nodeId: 'set', nodeName: '값 설정', status: 'SUCCEEDED', outputJson: '{"value":"new"}' }] }
  const previous = { id: 'previous', startedAt: '2026-10-12T14:00:00Z', nodes: [{ id: 'previous-node', nodeId: 'set', nodeName: '값 설정', status: 'SUCCEEDED', outputJson: '{"value":"old"}' }] }
  Object.assign(modules, {
    '../components/PageHeader': { PageHeader: 'page-header' }, '../app/AppShell': { AppShellTier1: 'shell' },
    '../app/WorkspaceContext': { useApi: () => ({ runsApi: {} }), useWorkspace: () => ({ current: { origin: 'local', myRole: 'OWNER' } }) },
    '../components/toast': { toast() {} }, '../components/Modal': { Modal: 'modal' }, '../lib/apiError': {}, '../design/ui': { ui: {} }, 'react-router-dom': { Link: 'link' },
    '@tanstack/react-query': {
      useQuery: ({ queryKey }) => ({ data: queryKey[0] === 'exec-flow-runs' ? [previous] : queryKey[1] === 'previous' ? previous : current }), useMutation: () => ({}),
    },
  })
  const { ExecutionDetailModal, nodeSig } = load('routes/Executions.tsx', '\nexport { ExecutionDetailModal, nodeSig };')
  const render = renderer(() => ExecutionDetailModal({ execId: 'current', onClose() {} }))
  let tree = render()
  button(tree, '값 설정').props.onClick(); tree = render()
  assert.equal(walk(tree, node => node.type === logs.LogBlock && node.props.title === '출력')[0].props.text, '{"value":"new"}')
  assert.doesNotMatch(text(tree), /기록된 상세가 없습니다/)
  button(tree, '이전 실행과 비교').props.onClick(); tree = render()
  assert.match(text(tree), /변경/)
  assert.equal(walk(tree, node => node.type === logs.LogBlock && node.props.title === '이전 출력')[0].props.text, '{"value":"old"}')
  assert.notEqual(nodeSig(current.nodes[0]), nodeSig(previous.nodes[0]), 'history comparison detects outputJson-only changes')
}
function environmentFreeze() {
  let disabled = false, selected = []
  const localStore = { active: '개발', envs: { 개발: { url: 'local' } } }, serverStore = { active: '운영', envs: { 운영: { url: 'server' } } }
  const local = { setActiveEnv: name => selected.push(['local', name]) }, server = { setActiveEnv: name => selected.push(['server', name]) }
  Object.assign(modules, {
    'react-router-dom': { Link: 'link', useLocation: () => ({ search: '?space=local%3Apc' }) }, 'react-dom': { createPortal: node => node },
    '../lib/environments': { useEnvironmentSource: () => ({ origin: 'local', setOrigin: origin => selected.push(['source', origin]) }), useEnvironment: origin => origin === 'server' ? server : local, useEnvStore: origin => origin === 'server' ? serverStore : localStore, useEnvironmentLoadStatus: () => 'ready' },
    './EnvManagerDialog': { EnvManagerDialog: 'env-manager' }, './useAnchoredPopover': { useAnchoredPopover: () => ({ ready: false, popupRef: { current: null }, style: {} }) },
    './AppIcon': { AppIcon: 'icon' }, '../app/WorkspaceContext': { useWorkspace: () => ({ current: { origin: 'local' }, connected: true }) }, '../auth/AuthContext': { useAuth: () => ({ desktop: {} }) }, '../lib/frontendMock': { FRONTEND_MOCK: true },
  })
  const { EnvSwitcher } = load('components/EnvSwitcher.tsx')
  const render = renderer(() => EnvSwitcher({ disabled }))
  const trigger = tree => walk(tree, node => node.type === 'button' && node.props.className?.includes('fl-env-trigger'))[0]
  let tree = render()
  assert.equal(trigger(tree).props.disabled, false)
  assert.equal(walk(tree, node => node.type === 'link').length, 1, 'default callers retain environment management navigation')
  trigger(tree).props.onClick(); tree = render()
  assert.ok(walk(tree, node => node.props?.['data-env-option'] === true).length >= 2)
  disabled = true; tree = render()
  assert.equal(trigger(tree).props.disabled, true)
  assert.equal(trigger(tree).props['aria-expanded'], false)
  assert.equal(walk(tree, node => node.type === 'link' || node.props?.['data-env-option'] === true).length, 0, 'execution preparation removes open selectors and environment management links immediately')
  trigger(tree).props.onClick(); tree = render()
  assert.equal(walk(tree, node => node.props?.['data-env-option'] === true).length, 0)
  assert.equal(selected.length, 0)
  disabled = false; tree = render()
  assert.equal(trigger(tree).props['aria-expanded'], false, 'completion does not reopen the old environment menu')
  trigger(tree).props.onClick(); tree = render()
  button(tree, '환경 관리').props.onClick(); tree = render()
  assert.equal(walk(tree, node => node.type === 'env-manager').length, 1)
  disabled = true; tree = render()
  assert.equal(walk(tree, node => node.type === 'env-manager').length, 0)
  const switcher = find(editor, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(editor) === 'EnvSwitcher')
  assert.ok(switcher.attributes.properties.some(node => node.name?.getText(editor) === 'disabled' && node.initializer.expression.getText(editor) === 'running'), 'Editor freezes environment selection throughout preparation and execution')
}
Promise.resolve().then(saveAndRun).then(failureAndRetry).then(resultsAndRecovery).then(historyOutputs).then(environmentFreeze).then(() => console.log('PASS: workflow save/run sequencing, deferred-edit protection, failure recovery, result-panel/history output and environment freeze')).catch(error => { console.error(error); process.exitCode = 1 })
