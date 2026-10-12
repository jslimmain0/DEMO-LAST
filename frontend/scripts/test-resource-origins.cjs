const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')

const saved = new Map()
const writes = []
let mock = true, failServerSave = false, failServerLoad = false
const localApi = { environmentsApi: { list: async () => [{ name: '개발', vars: { ADDRESS: 'PC' } }], put: async (name, vars) => { writes.push({ origin: 'local', name, vars }) }, remove: async () => {} } }
const centralApi = { environmentsApi: { list: async () => { if (failServerLoad) throw new Error('offline'); return [{ name: '개발', vars: { ADDRESS: 'SERVER' } }] }, put: async (name, vars) => { writes.push({ origin: 'server', name, vars }); if (failServerSave) throw new Error('offline') }, remove: async () => {} }, protocolsApi: {}, secretsApi: {}, transformsApi: {}, pluginsApi: {}, codecsApi: {} }
const scope = { current: { origin: 'local', id: 'pc' }, scopeKey: 'local:pc', remoteKey: 'company:alice:true', connected: true, workspaces: [{ origin: 'local', id: 'pc' }], api: localApi, agentApi: origin => origin === 'local' ? localApi : centralApi }
const react = { useMemo: make => make(), useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
function load(file, modules, globals = {}, extra = '') {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8') + extra, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports, structuredClone, setTimeout, clearTimeout, document: { body: {} }, ...globals, localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }, require: name => modules[name] ?? {} })
  return exports
}
const flag = { get FRONTEND_MOCK() { return mock } }
const unloadHandlers = []
const environment = load('lib/environments.ts', { react, '../app/WorkspaceContext': { useApi: () => scope.api, useWorkspace: () => scope }, '../components/toast': { toast() {} }, './frontendMock': flag }, { window: { addEventListener: (event, handler) => { if (event === 'beforeunload') unloadHandlers.push(handler) } } })
const agent = load('components/AgentSettings.tsx', { react, '../app/WorkspaceContext': { useWorkspace: () => scope, useCentralApi: () => centralApi }, '../auth/AuthContext': { useAuth: () => ({ desktop: {} }) }, '../lib/frontendMock': flag, '../lib/executionAgentSelection': { usesWorkflowContext: () => false } })
const jsx = (type, props, key) => ({ type, props, key })
const uiReact = { ...react, useEffect() {}, useRef: initial => ({ current: initial }), lazy: () => 'lazy-editor' }
let stateIndex = 0
uiReact.useState = initial => [stateIndex++ === 1 ? true : initial, () => {}]
const switcher = load('components/EnvSwitcher.tsx', { react: uiReact, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-dom': { createPortal: node => node }, 'react-router-dom': { useLocation: () => ({ search: '?space=local:pc' }) }, '../app/WorkspaceContext': { useWorkspace: () => scope }, '../auth/AuthContext': { useAuth: () => ({ desktop: {} }) }, '../lib/environments': environment, '../lib/frontendMock': flag, './useAnchoredPopover': { useAnchoredPopover: () => ({ ready: false, style: {}, popupRef: {} }) } }, { URLSearchParams })
const editorModules = { react: uiReact, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../app/WorkspaceContext': { useWorkspace: () => scope }, '../design/ui': { ui: {} } }
const secretEditor = load('components/SecretsDialog.tsx', editorModules)
const pluginEditor = load('routes/Plugins.tsx', editorModules)
const mutationCallbacks = [], editorCleanup = [], secretNotices = []
let invalidations = 0
const secretMutationEditor = load('components/SecretsDialog.tsx', {
  ...editorModules,
  react: { ...uiReact, useState: initial => [initial, () => {}], useEffect: effect => { const cleanup = effect(); if (cleanup) editorCleanup.push(cleanup) } },
  '../app/WorkspaceContext': { useWorkspace: () => scope, useCentralApi: () => centralApi },
  '../lib/frontendMock': flag,
  '../auth/AuthContext': { usePermissions: () => ({ canEdit: true }) },
  '../lib/environments': { useEnvStore: () => ({ active: null, envs: {} }) },
  './toast': { toast: message => secretNotices.push(message) },
  './UnsavedNavigation': { useUnsavedNavigation() {} },
  '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: () => invalidations++ }), useQuery: () => ({ data: [] }), useMutation: callbacks => { mutationCallbacks.push(callbacks); return { isPending: false } } },
}, {}, '\nexport { SecretEditorPanel };')
function walk(node, predicate, results = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, results))
  else if (node && typeof node === 'object') { if (predicate(node)) results.push(node); walk(node.props?.children, predicate, results) }
  return results
}
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : ''
const renderSwitcher = () => { stateIndex = 0; return switcher.EnvSwitcher() }
const navigationGuards = []
const resourceModules = { ...editorModules, react: { ...uiReact, useState: initial => [initial, () => {}] }, '../lib/environments': environment, '../lib/frontendMock': flag, 'react-router-dom': { useSearchParams: () => [new URLSearchParams('tab=environments'), () => {}] }, '../components/UnsavedNavigation': { useUnsavedNavigation: guard => navigationGuards.push(guard) }, './UnsavedNavigation': { useUnsavedNavigation: guard => navigationGuards.push(guard) } }
const resourcePage = load('routes/Resources.tsx', resourceModules)
const environmentManager = load('components/EnvManagerDialog.tsx', resourceModules)
let compactStateIndex = 0
const compactStates = []
const compactManager = load('components/EnvManagerDialog.tsx', { ...resourceModules, react: { ...uiReact, useEffect() {}, useState: initial => {
  const index = compactStateIndex++
  if (!(index in compactStates)) compactStates[index] = typeof initial === 'function' ? initial() : initial
  return [compactStates[index], value => { compactStates[index] = value }]
} } })
const renderCompact = () => { compactStateIndex = 0; return compactManager.EnvManagerPanel({ compact: true, origin: 'local' }) }
function unloadBlocked() {
  let blocked = false
  unloadHandlers.forEach(handler => handler({ preventDefault: () => { blocked = true } }))
  return blocked
}
const inspections = [], inspectionCalls = []
const planNodes = [{ id: 'request', type: 'http', executionAgent: 'local' }, { id: 'central', type: 'transform', transformId: 'normalize' }]
const planScope = { ...scope, current: { origin: 'local', id: 'pc', name: '내 PC' }, agentApi: (origin, workspaceId) => ({ runsApi: { inspectAgent: async (node, envName, envSource, env) => { inspectionCalls.push({ origin, workspaceId, node, envName, envSource, env }); return { ready: true } } } }) }
let selectedPlanOrigin = 'server'
const plan = load('components/ExecutionPlanDialog.tsx', {
  react: { ...uiReact, useState: initial => [initial, () => {}] },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  '../app/WorkspaceContext': { useWorkspace: () => planScope },
  '../auth/AuthContext': { useAuth: () => ({ desktop: {} }) },
  '../lib/frontendMock': flag,
  '../store/editorStore': { useEditorStore: selector => selector({ nodes: planNodes.map(node => ({ id: node.id, data: node })), edges: [] }) },
  '../canvas/graphAdapter': { asGraphNode: node => node },
  '../canvas/nodeMeta': { typeLabel: type => type },
  '../lib/runProgress': { topoOrder: () => planNodes.map(node => node.id) },
  '../lib/reachable': { computeReachInfo: () => ({ hasStart: false }) },
  '../lib/environments': { useEnvStore: origin => ({ active: '개발', envs: { 개발: { ADDRESS: origin === 'local' ? 'PC snapshot' : 'SERVER snapshot' } } }), useEnvironment: () => ({ origin: selectedPlanOrigin, prepareForRun: async () => {} }) },
  '../lib/executionAgentSelection': { usesWorkflowContext: () => false },
  './AgentSettings': agent,
  '../lib/agentEnvironments': load('lib/agentEnvironments.ts', {}),
  '../lib/useAgentEnvironmentBindings': { useAgentEnvironmentBindings: () => ({ ready: true, bindings: {} }) },
  '../design/ui': { ui: {} },
  '@tanstack/react-query': { useQuery: () => ({ isSuccess: true, isPending: false, isFetching: false }), useQueries: ({ queries }) => { inspections.push(...queries); return queries.map(() => ({ data: { ready: true, issues: [] } })) } },
})

async function run() {
  const local = environment.useEnvironment('local'), server = environment.useEnvironment('server')
  await Promise.all([local.ensureEnvLoaded(), server.ensureEnvLoaded()])
  local.setActiveEnv('개발'); server.setActiveEnv('개발')
  assert.equal(environment.useEnvironment().activeEnvVars().ADDRESS, 'PC')
  environment.useEnvironmentSource().setOrigin('server')
  assert.equal(environment.useEnvironment().activeEnvVars().ADDRESS, 'SERVER')
  assert.equal(environment.useEnvironment().activeEnvSource(), 'server')
  local.setEnvStore({ active: '개발', envs: { 개발: { ADDRESS: 'PC changed' } } })
  await local.flushEnvStore()
  assert.equal(server.activeEnvVars().ADDRESS, 'SERVER', 'same-named environments must never merge')
  assert.equal(writes.at(-1).origin, 'local')
  failServerSave = true
  server.setEnvStore({ active: '개발', envs: { 개발: { ADDRESS: 'SERVER draft' } } })
  await server.flushEnvStore()
  assert.equal(server.getSaveStatus(), 'error')
  resourcePage.Resources()
  assert.ok(navigationGuards.every(guard => !guard.dirty && !guard.saving && !guard.blockedReason), 'failed API save must not trap unrelated route navigation')
  assert.equal(unloadBlocked(), true, 'unsaved API draft blocks reload even after leaving its page')
  let closed = false
  const dialog = environmentManager.EnvManagerDialog({ onClose: () => { closed = true } })
  walk(dialog, node => node.type === 'button' && text(node) === '닫기')[0].props.onClick()
  assert.equal(closed, true, 'failed API save does not trap modal close')
  assert.equal(server.activeEnvVars().ADDRESS, 'SERVER draft', 'leaving or closing preserves failed values in the session store')
  scope.connected = false; scope.remoteKey = 'company:alice:false'
  assert.equal(environment.useEnvironment('local'), local, 'server disconnect preserves PC state')
  assert.equal(environment.useEnvironment('server'), server, 'server disconnect preserves failed server draft')
  assert.equal(server.activeEnvVars().ADDRESS, 'SERVER draft')
  environment.useEnvironmentSource().setOrigin('local')
  assert.equal(environment.useEnvironment().activeEnvVars().ADDRESS, 'PC changed')
  const resource = agent.useNodeResources({ type: 'http', executionAgent: 'local' })
  assert.equal(resource.api.secretsApi, centralApi.secretsApi)
  assert.equal(resource.api.protocolsApi, centralApi.protocolsApi)
  const serverResource = agent.useNodeResources({ type: 'http', executionAgent: 'server' })
  assert.equal(JSON.stringify(resource.key), JSON.stringify(serverResource.key), 'central catalog cache is shared across execution locations')
  assert.notEqual(JSON.stringify(resource.environmentKey), JSON.stringify(serverResource.environmentKey), 'execution-location environment caches must not share same-named values')
  assert.equal(resource.available, true, 'local HTTP remains available while server is disconnected')
  assert.equal(agent.useNodeResources({ type: 'transform' }).available, false)
  scope.connected = true; scope.remoteKey = 'company:alice:true'
  assert.equal(environment.useEnvironment('server'), server)
  failServerSave = false
  await server.flushEnvStore()
  assert.equal(server.getSaveStatus(), 'saved')
  assert.equal(unloadBlocked(), false, 'retry clears reload protection only after every draft is saved')
  scope.remoteKey = 'company:bob:true'
  assert.notEqual(environment.useEnvironment('server'), server, 'server accounts must not share drafts')
  assert.equal(environment.useEnvironment('local'), local, 'changing server account preserves PC data')
  assert.equal(agent.useNodeResources({ type: 'transform' }).available, true, 'mock allows central transform from local workflow')
  mock = false
  environment.useEnvironmentSource().setOrigin('server')
  assert.equal(environment.useEnvironment().activeEnvSource(), 'server', 'production supports explicit server environment selection from a local workflow')
  assert.equal(agent.useNodeResources({ type: 'transform' }).available, true, 'production allows central transforms from local workflows')
  const productionResources = agent.useNodeResources({ type: 'http', executionAgent: 'local' })
  assert.equal(productionResources.api.environmentsApi, localApi.environmentsApi, 'production keeps destination environment API')
  assert.equal(productionResources.api.secretsApi, centralApi.secretsApi, 'production uses server common secrets')
  mock = true; scope.remoteKey = 'company:alice:true'
  let tree = renderSwitcher()
  const serverChoice = walk(tree, node => node.type === 'button' && node.props.title?.startsWith('서버 · 개발'))[0]
  serverChoice.props.onClick()
  assert.equal(environment.useEnvironment().activeEnvSource(), 'server')
  assert.equal(environment.useEnvironment().activeEnvVars().ADDRESS, 'SERVER draft', 'actual picker selects the server source even when names match')
  const secretKey = secretEditor.SecretsPanel({}).key, pluginKey = pluginEditor.Plugins().key
  scope.remoteKey = 'company:alice:false'
  assert.equal(secretEditor.SecretsPanel({}).key, secretKey)
  assert.equal(pluginEditor.Plugins().key, pluginKey)
  scope.remoteKey = 'company:bob:true'
  assert.notEqual(secretEditor.SecretsPanel({}).key, secretKey)
  assert.notEqual(pluginEditor.Plugins().key, pluginKey)
  scope.remoteKey = 'company:loading:true'
  tree = renderSwitcher()
  assert.match(text(tree), /환경을 불러오는 중/)
  assert.doesNotMatch(text(tree), /환경이 없습니다/)
  failServerLoad = true
  await assert.rejects(environment.useEnvironment('server').ensureEnvLoaded(), /offline/)
  tree = renderSwitcher()
  assert.match(text(tree), /환경을 불러오지 못했습니다/)
  assert.doesNotMatch(text(tree), /환경이 없습니다/)
  failServerLoad = false
  await environment.useEnvironment('server').ensureEnvLoaded()
  tree = plan.ExecutionPlanDialog({ onClose() {}, onRun() {} })
  assert.match(text(tree), /서버 · 개발/, 'actual plan summary includes environment source for a local workflow')
  for (const query of inspections.filter(query => query.enabled)) await query.queryFn()
  assert.equal(inspectionCalls.length, 2)
  assert.ok(inspectionCalls.every(call => call.envSource === 'server'))
  assert.equal(inspectionCalls.find(call => call.node.id === 'request').origin, 'local')
  assert.equal(inspectionCalls.find(call => call.node.id === 'central').workspaceId, 'public')
  assert.equal(inspections[0].queryKey.at(-4), 'server', 'inspection cache includes explicit source')
  mock = false; selectedPlanOrigin = 'local'; inspections.length = 0; inspectionCalls.length = 0
  plan.ExecutionPlanDialog({ onClose() {}, onRun() {} })
  for (const query of inspections.filter(query => query.enabled)) await query.queryFn()
  assert.ok(inspectionCalls.every(call => call.envSource === 'local'), 'production inspection keeps the explicitly selected PC source')
  assert.ok(inspectionCalls.every(call => call.env.ADDRESS === 'PC snapshot'), 'PC snapshots travel with inspection even for server transforms')
  secretMutationEditor.SecretEditorPanel({})
  mutationCallbacks[0].onSuccess()
  assert.equal(invalidations, 1)
  assert.equal(secretNotices.length, 1)
  editorCleanup[0]()
  mutationCallbacks[0].onSuccess(); mutationCallbacks[0].onError(); mutationCallbacks[1].onSuccess()
  assert.equal(invalidations, 1, 'a prior account editor cannot invalidate the new account catalog')
  assert.equal(secretNotices.length, 1, 'stale save results do not show a success/failure in the new account editor')
  mock = true; scope.remoteKey = 'company:alice:true'
  local.setEnvStore({ active: '개발', envs: { ...local.getEnvStore().envs, 테스트: { ADDRESS: 'PC TEST' } } }); await local.flushEnvStore()
  environment.useEnvironmentSource().setOrigin('server')
  tree = renderCompact()
  const compactSelect = walk(tree, node => node.type === 'select' && node.props['aria-label'] === '내 PC 편집할 환경')[0]
  compactSelect.props.onChange({ target: { value: '테스트' } })
  assert.equal(compactStates[2], '테스트')
  assert.equal(local.activeEnvName(), '개발', 'editing another environment does not activate it')
  assert.equal(environment.useEnvironmentSource().origin, 'server', 'editing a PC environment does not silently change execution source')
  tree = renderCompact()
  walk(tree, node => node.type === 'button' && text(node) === '실행 환경으로 선택')[0].props.onClick()
  assert.equal(local.activeEnvName(), '테스트')
  assert.equal(environment.useEnvironmentSource().origin, 'local', 'explicit activation selects the PC source')
  compactStates[0] = true; tree = renderCompact()
  walk(tree, node => node.type === 'select' && node.props['aria-label'] === '내 PC 편집할 환경')[0].props.onChange({ target: { value: '개발' } })
  assert.equal(compactStates[2], '테스트', 'unapplied text blocks edit selection until confirmed')
  compactStates[1].onConfirm()
  assert.equal(compactStates[2], '개발')
  console.log('PASS: source-specific environments stay distinct and PC drafts survive account changes; Mock and production central catalogs are shared')
  console.log('PASS: actual picker keeps source identity, central editor drafts reset across accounts only, loading/error retain recovery instead of empty state')
  console.log('PASS: actual execution plan sends explicit source and PC snapshots to local/central inspections in Mock and production')
  console.log('PASS: failed API drafts permit other routes/modal close, remain in session, protect reload, and clear protection after retry')
  console.log('PASS: old-account secret mutation completions are ignored after editor unmount')
  console.log('PASS: compact environment selection edits independently, activation names source, and unapplied drafts require confirmation')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
