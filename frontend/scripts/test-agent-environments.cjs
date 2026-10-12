// Run: node frontend/scripts/test-agent-environments.cjs (actual resolver + binding hook; no network/MCP).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const designUi = (() => { const out = {}; require('node:vm').runInNewContext(require('typescript').transpileModule(require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/design/ui.ts'), 'utf8'), { compilerOptions: { module: require('typescript').ModuleKind.CommonJS, target: require('typescript').ScriptTarget.ES2022 } }).outputText, { exports: out }); return out })()
const unloadHandlers = []
function load(file, modules) {
  const exports = {}
  const text = fs.readFileSync(path.join(__dirname, file), 'utf8') + (file.endsWith('ExecutionPlanDialog.tsx') ? '\nexport { DestinationEnvironment };' : '')
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports, window: { location: { origin: 'https://server-browser.test' }, addEventListener: (name, handler) => { if (name === 'beforeunload') unloadHandlers.push(handler) } }, require: name => modules[name] ?? (name.endsWith('/design/ui') ? designUi : {}) })
  return exports
}
const resolver = load('../src/lib/agentEnvironments.ts', {})
const owner = { origin: 'server', id: 'team' }
assert.equal(resolver.resolveAgentEnvironment({}, 'local', 'pc', owner, 'dev', {}).name, undefined)
assert.equal(resolver.resolveAgentEnvironment({}, 'server', 'another', owner, 'dev', {}).name, undefined)
assert.equal(resolver.resolveAgentEnvironment({}, 'server', 'team', owner, 'dev', {}).name, 'dev')
assert.equal(resolver.resolveAgentEnvironment({}, 'local', 'pc', owner, 'dev', { local: '' }).name, '')
assert.equal(resolver.resolveAgentEnvironment({ agentEnvironment: '' }, 'local', 'pc', owner, 'dev', { local: 'personal-dev' }).name, '')
assert.equal(resolver.agentEnvironmentSource({ type: 'http' }, 'server', 'team', 'local', {}), 'local', 'a destination without an override uses the selected workflow source')
assert.equal(resolver.agentEnvironmentSource({ type: 'http', agentEnvironment: '' }, 'server', 'team', 'local', {}), 'server', 'an explicit common destination environment still selects that destination source')
assert.equal(resolver.agentEnvironmentSource({ type: 'tcp' }, 'server', 'team', 'local', { 'server:team': 'dev' }), 'server')
assert.equal(resolver.agentEnvironmentSource({ type: 'http' }, 'local', 'pc', 'server', { local: 'dev' }), 'local')
for (const node of [{ type: 'transform', agentEnvironment: 'old' }, { type: 'set', agentEnvironment: 'old' }, { type: 'http', reqMode: 'client', agentEnvironment: 'old' }]) {
  assert.equal(resolver.agentEnvironmentSource(node, 'server', 'team', 'local', { 'server:team': 'dev' }), 'local', 'workflow-context nodes ignore historical destination overrides')
}
console.log('PASS: cross-space requires explicit choice; common is explicit; node override wins')
const rules = load('../src/lib/executionAgentSelection.ts', {})
const nodes = load('../src/components/AgentSettings.tsx', {
  '../lib/executionAgentSelection': rules,
  '../app/WorkspaceContext': {useWorkspace: () => ({current: owner})},
  '../auth/AuthContext': {useAuth: () => ({desktop: {}})},
})
assert.equal(nodes.usesOwnerResources({ type: 'form', executionAgent: 'local' }), true)
assert.equal(nodes.usesOwnerResources({ type: 'input' }), true)
assert.equal(nodes.usesOwnerResources({ type: 'switch', executionAgent: 'local' }), true)
assert.equal(nodes.usesOwnerResources({ type: 'http', reqMode: 'client', executionAgent: 'server' }), true)
assert.equal(nodes.usesOwnerResources({ type: 'tcp', executionAgent: 'local' }), false)
assert.equal(nodes.nodeAgent({ type: 'switch', executionAgent: 'local' }, 'server'), 'server')
for (const type of ['set', 'if', 'assert']) {
  const node = {type, executionAgent: 'local', agentEnvironment: 'wrong'}
  assert.equal(nodes.usesOwnerResources(node), true)
  assert.equal(nodes.nodeAgent(node, 'server'), 'server')
  assert.equal(rules.canChangeExecutionAgent(node), false)
  assert.equal(nodes.NodeAgentBadge({node}), null)
  assert.equal(nodes.AgentSettings({node, update() {}, disabled: false}), null)
}
console.log('PASS: calculations ignore legacy destinations and use owner resources; HTTP/TCP use destination')
const inspectionQueries = [], inspectionRequests = [], destinationRequests = [], destinationQueries = []
const planNodes = [
  { id: 'form', type: 'form', executionAgent: 'local', agentEnvironment: 'wrong-private' },
  { id: 'input', type: 'input' },
  { id: 'switch', type: 'switch', executionAgent: 'local' },
  { id: 'browser', type: 'http', reqMode: 'client', executionAgent: 'local' },
  ...['set', 'if', 'assert'].map(type => ({id: type, type, executionAgent: 'local', agentWorkspaceId: 'other', agentEnvironment: 'wrong-private'})),
  { id: 'pc', type: 'http', executionAgent: 'local' },
]
const planWorkspace = { current: { ...owner, name: '팀' }, scopeKey: 'server:team', remoteKey: 'alice', connected: true, resourceIdentity: { serverUrl: 'https://company.test', login: 'alice' }, workspaces: [{ origin: 'local', id: 'pc' }, { ...owner, name: '팀' }], agentApi: (agent, workspaceId) => ({ environmentsApi: { list: () => { destinationRequests.push({ agent, workspaceId }); return [] } }, runsApi: { inspectAgent: async (node, envName, envSource, env, resourceIdentity) => { inspectionRequests.push({ agent, workspaceId, node, envName, envSource, env, resourceIdentity }); return {} } } }) }
const plan = load('../src/components/ExecutionPlanDialog.tsx', {
  react: { useMemo: make => make(), useState: initial => [initial, () => {}], useRef: value => ({ current: value }), useEffect: () => {} },
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  '@tanstack/react-query': { useQuery: query => { if (query.queryKey[0] === 'destination-environments') destinationQueries.push(query); return { data: [], isSuccess: true, isFetching: false } }, useQueries: ({ queries }) => { inspectionQueries.push(...queries); return queries.map(() => ({ data: { ready: true, issues: [] } })) } },
  '../app/WorkspaceContext': { useWorkspace: () => planWorkspace },
  '../auth/AuthContext': { useAuth: () => ({ desktop: {} }) },
  '../store/editorStore': { useEditorStore: selector => selector({ nodes: planNodes.map(node => ({ id: node.id, data: node })), edges: [] }) },
  '../canvas/graphAdapter': { asGraphNode: node => node },
  '../canvas/nodeMeta': { typeLabel: type => type },
  '../lib/runProgress': { topoOrder: () => planNodes.map(node => node.id) },
  '../lib/reachable': { computeReachInfo: () => ({ hasStart: false }) },
  '../lib/environments': { useEnvStore: () => ({ active: 'dev', envs: { 'personal-dev': { address: 'PC' } } }), useEnvironment: () => ({ prepareForRun: async () => {} }) },
  './AgentSettings': nodes,
  '../lib/executionAgentSelection': rules,
  '../lib/agentEnvironments': resolver,
  '../lib/useAgentEnvironmentBindings': { useAgentEnvironmentBindings: () => ({ ready: true, bindings: { local: 'personal-dev' } }) },
})
plan.ExecutionPlanDialog({ onClose: () => {}, onRun: () => {} })
plan.DestinationEnvironment({ destination: 'server:team', target: { agent: 'server', workspaceId: 'team' }, bindings: { ready: true, bindings: {}, update() {} } })
assert.equal(destinationQueries[0].queryKey.at(-1), 'public', 'server environment options use the public catalog while destination metadata remains team-scoped')
destinationQueries[0].queryFn()
assert.deepEqual(destinationRequests, [{ agent: 'server', workspaceId: 'public' }])
assert.equal(inspectionQueries[2].enabled, false, 'switch has no agent resource inspection')
let stage = 'dev', login = 'alice', loadError = false, connectionReady = true, native = true, authReady = true, pending, environmentSource = 'server'
const frontendFlag = { FRONTEND_MOCK: false }
const cache = new Map(), writes = []
const workspace = { current: owner }
const identity = () => ({ serverUrl: 'https://company.test', login, connected: true })
const queryClient = { getQueryData: key => cache.get(JSON.stringify(key)), setQueryData: (key, value) => cache.set(JSON.stringify(key), value) }
const hook = load('../src/lib/useAgentEnvironmentBindings.ts', {
  react: { useEffect: () => {} },
  '../app/WorkspaceContext': { useWorkspace: () => workspace },
  '../auth/AuthContext': { useAuth: () => ({ desktop: native ? identity() : undefined, ready: authReady, me: login ? { username: login } : null }) },
  './environments': { useEnvStore: () => ({ active: stage }), useEnvironment: () => ({ origin: environmentSource }) },
  './frontendMock': frontendFlag,
  '../auth/desktop': { desktopApi: { saveEnvironmentBindings: (scope, value, connection) => { writes.push({ scope, value, connection }); return new Promise((resolve, reject) => { pending = { resolve, reject } }) } } },
  '@tanstack/react-query': { useQueryClient: () => queryClient, useQuery: ({ queryKey }) => {
    if (queryKey[0] === 'desktop') return { data: connectionReady ? identity() : undefined, isSuccess: connectionReady, error: connectionReady ? null : new Error('connection failed') }
    const key = JSON.stringify(queryKey)
    if (!cache.has(key)) cache.set(key, { bindings: {}, revision: '' })
    return { data: cache.get(key), isSuccess: !loadError, isPending: false, error: loadError ? new Error('load failed') : null }
  } },
})
async function run() {
  for (const query of inspectionQueries.filter(query => query.enabled)) await query.queryFn()
  for (const id of ['form', 'input', 'browser', 'set', 'if', 'assert']) {
    const request = inspectionRequests.find(request => request.node.id === id)
    assert.equal(request.agent, 'server')
    assert.equal(request.workspaceId, 'team')
    assert.equal(request.envName, 'dev', `${id}: owner context ignores PC map/node override`)
  }
  assert.equal(inspectionRequests.find(request => request.node.id === 'pc').envName, 'personal-dev')
  assert.equal(inspectionRequests.find(request => request.node.id === 'pc').envSource, 'local')
  assert.deepEqual(inspectionRequests.find(request => request.node.id === 'pc').env, { address: 'PC' })
  assert.equal(inspectionRequests.find(request => request.node.id === 'form').envSource, 'server')
  assert.deepEqual(inspectionRequests.find(request => request.node.id === 'pc').resourceIdentity, planWorkspace.resourceIdentity)
  console.log('PASS: actual execution-plan inspect requests use owner for form/input/browser and selected destination for PC HTTP')
  let binding = hook.useAgentEnvironmentBindings()
  binding.update('local', 'pc-dev')
  const unload = () => { let blocked = false; const event = { preventDefault: () => { blocked = true } }; unloadHandlers.forEach(handler => handler(event)); return blocked }
  stage = 'prod'
  hook.useAgentEnvironmentBindings()
  assert.equal(unload(), true, 'unload protects dirty draft even outside its current stage/plan')
  stage = 'dev'
  binding = hook.useAgentEnvironmentBindings()
  const first = binding.save()
  binding.update('local', 'pc-new')
  pending.resolve({ bindings: { local: 'pc-dev' }, revision: 'r1' })
  await assert.rejects(first, /저장 중 연결 설정/)
  binding = hook.useAgentEnvironmentBindings()
  assert.equal(binding.bindings.local, 'pc-new')
  assert.equal(binding.dirty, true)
  const retry = binding.save()
  assert.equal(writes[1].value.revision, 'r1')
  pending.resolve({ bindings: { local: 'pc-new' }, revision: 'r2' })
  await retry
  assert.equal(hook.useAgentEnvironmentBindings().dirty, false)
  assert.equal(unload(), false)
  stage = 'prod'
  assert.equal(hook.useAgentEnvironmentBindings().bindings.local, undefined)
  stage = 'dev'; login = 'bob'
  assert.equal(hook.useAgentEnvironmentBindings().bindings.local, undefined)
  login = 'alice'
  assert.equal(hook.useAgentEnvironmentBindings().bindings.local, 'pc-new')
  native = false
  binding = hook.useAgentEnvironmentBindings()
  binding.update('local', 'browser-alice')
  login = 'bob'
  assert.equal(hook.useAgentEnvironmentBindings().bindings.local, undefined)
  login = 'alice'
  assert.equal(hook.useAgentEnvironmentBindings().bindings.local, 'browser-alice')
  login = null
  assert.equal(hook.useAgentEnvironmentBindings().ready, false, 'no shared anonymous account bucket')
  await assert.rejects(hook.useAgentEnvironmentBindings().save(), /먼저 불러/)
  login = 'alice'; native = true
  connectionReady = false
  binding = hook.useAgentEnvironmentBindings()
  assert.equal(binding.ready, false)
  await assert.rejects(binding.save(), /먼저 불러/)
  connectionReady = true
  loadError = true
  binding = hook.useAgentEnvironmentBindings()
  binding.update('local', 'bad')
  await assert.rejects(binding.save(), /먼저 불러/)
  assert.equal(hook.useAgentEnvironmentBindings().bindings.local, 'pc-new')
  console.log('PASS: A saving/B editing retains draft+revision; stage/account isolate; failed GET/connection blocks mutation/run')
  loadError = false; frontendFlag.FRONTEND_MOCK = true; stage = '개발'; environmentSource = 'local'
  binding = hook.useAgentEnvironmentBindings()
  binding.update('local', 'local-destination')
  const localSave = binding.save(), localPending = pending
  assert.equal(writes.at(-1).scope.environment, 'local:개발')
  environmentSource = 'server'
  binding = hook.useAgentEnvironmentBindings()
  assert.equal(binding.bindings.local, undefined, 'same name from another source cannot inherit local binding draft')
  binding.update('local', 'server-destination')
  const serverSave = binding.save(), serverPending = pending
  assert.equal(writes.at(-1).scope.environment, 'server:개발')
  serverPending.resolve({ bindings: { local: 'server-destination' }, revision: 'server-r1' }); await serverSave
  localPending.resolve({ bindings: { local: 'local-destination' }, revision: 'local-r1' }); await localSave
  assert.equal(hook.useAgentEnvironmentBindings().bindings.local, 'server-destination')
  environmentSource = 'local'; binding = hook.useAgentEnvironmentBindings()
  assert.equal(binding.bindings.local, 'local-destination')
  binding.update('local', 'local-next')
  const next = binding.save()
  assert.equal(writes.at(-1).value.revision, 'local-r1', 'source revisions must remain independent')
  pending.resolve({ bindings: { local: 'local-next' }, revision: 'local-r2' }); await next
  environmentSource = 'server'; assert.equal(hook.useAgentEnvironmentBindings().bindings.local, 'server-destination')
  console.log('PASS: same-named local/server stages isolate persistent keys, drafts and revisions in Mock and production')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
