// Run: node frontend/scripts/test-personal-api-identity.cjs
// Executes actual WorkspaceProvider hooks and actual environment WeakMap store without network/MCP.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
let hookIndex = 0
const hooks = []
let scope
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
const react = {
  createContext: () => ({ Provider: 'provider' }),
  useContext: () => scope,
  useEffect: () => {},
  useMemo: (make, deps) => { const i = hookIndex++; if (!hooks[i] || !sameDeps(hooks[i].deps, deps)) hooks[i] = { value: make(), deps }; return hooks[i].value },
  useCallback: (callback, deps) => react.useMemo(() => callback, deps),
  useState: initial => { const i = hookIndex++; if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[i].value, value => { hooks[i].value = value }] },
}
const localApi = { origin: 'local' }
const serverApi = { origin: 'server' }
let connection = { connected: false, login: null, serverUrl: 'https://first.company.test' }
const auth = { desktop: { connected: false, login: null, serverUrl: connection.serverUrl }, me: null }
const location = { pathname: '/resources', search: '?space=local%3Apc-id', hash: '' }
const timers = new Map()
let timer = 0
const base = {
  structuredClone, URLSearchParams,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  window: { location: { origin: 'http://localhost:18180', search: location.search } },
  setTimeout: fn => { timers.set(++timer, fn); return timer }, clearTimeout: id => timers.delete(id),
}
function load(file, requires) {
  const exported = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { ...base, exports: exported, require: name => requires[name] ?? {} })
  return exported
}
const createApi = (transport, workspaceId, resourceBase, expectedLogin) => ({ transport, workspaceId, resourceBase, expectedLogin, environmentsApi: { list: async () => [], put: async () => { throw new Error('offline') }, remove: async () => {} }, workspacesApi: {} })
const routePaths = load('../src/app/routePaths.ts', { 'react-router-dom': require('react-router-dom') })
const provider = load('../src/app/WorkspaceContext.tsx', {
  react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  '@tanstack/react-query': { hashKey: JSON.stringify, QueryClient: class {}, QueryClientProvider: 'query-provider', useQuery: ({ queryKey }) => ({ data: queryKey[0] === 'desktop' ? connection : queryKey[1] === 'local' ? [{ id: 'pc-id', name: '개인 공간', kind: 'PERSONAL', myRole: 'OWNER', canManage: true }] : [{ id: 'team-id', name: '팀 공간', kind: 'TEAM', myRole: 'EDITOR', canManage: false }], isLoading: false, refetch: () => {} }) },
  'react-router-dom': { useLocation: () => location, useNavigate: () => () => {} },
  '../api/client': { createApi, localApi, serverApi }, '../auth/AuthContext': { useAuth: () => auth }, '../auth/desktop': { desktopApi: {} }, '../store/editorStore': { useEditorStore: {} }, './routePaths': routePaths,
})
const environments = load('../src/lib/environments.ts', { react, '../app/WorkspaceContext': provider, '../components/toast': { toast: () => {} } })
const render = () => { hookIndex = 0; const result = provider.WorkspaceProvider({ children: null }); scope = result.props.value; return scope }
async function run() {
  const first = render()
  const store = environments.useEnvironment()
  await store.ensureEnvLoaded()
  store.setEnvStore({ active: 'dev', envs: { dev: { URL: 'unsaved-local-value' } } })
  await store.flushEnvStore()
  assert.equal(store.getSaveStatus(), 'error')
  connection = { connected: true, login: 'alice', serverUrl: connection.serverUrl }
  const loggedIn = render()
  assert.equal(loggedIn.api, first.api, 'server login must preserve personal API identity')
  assert.equal(loggedIn.scopeKey, first.scopeKey)
  assert.equal(environments.useEnvironment(), store, 'personal environment WeakMap store must survive login')
  assert.equal(store.getEnvStore().envs.dev.URL, 'unsaved-local-value')
  assert.equal(store.getSaveStatus(), 'error')
  connection = { connected: true, login: 'bob', serverUrl: 'https://second.company.test' }
  assert.equal(render().api, first.api, 'switching account and server must preserve personal API identity')
  assert.equal(environments.useEnvironment(), store)
  location.search = '?space=server%3Ateam-id'
  const remote = render()
  assert.notEqual(remote.api, first.api)
  assert.equal(remote.api.expectedLogin, 'bob')
  assert.equal(remote.api.resourceBase, 'https://second.company.test')
  connection = { ...connection, login: 'carol' }
  const switchedAccount = render()
  assert.notEqual(switchedAccount.api, remote.api, 'remote API must capture a new account')
  assert.equal(switchedAccount.api.expectedLogin, 'carol')
  connection = { ...connection, serverUrl: 'https://third.company.test' }
  const switchedServer = render()
  assert.notEqual(switchedServer.api, switchedAccount.api, 'remote API must capture a new server')
  assert.equal(switchedServer.api.resourceBase, 'https://third.company.test')
  console.log('PASS: actual provider memo preserves personal API/environment error draft across login/account/server changes; remote API captures account and server changes')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
