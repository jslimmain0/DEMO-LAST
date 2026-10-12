// Real route normalizer used by App redirects and WorkspaceProvider; no browser/backend/MCP traffic.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const api = {}
const source = fs.readFileSync(path.join(__dirname, '../src/app/routePaths.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
vm.runInNewContext(code, { exports: api, require, URLSearchParams })
const { workspaceLocation, routePaths, initialWorkspace } = api
const savedTeam = { origin: 'server', id: 'team-id' }
assert.equal(initialWorkspace('?runtime=local', true, savedTeam).origin, 'local')
assert.equal(initialWorkspace('?runtime=local', true, savedTeam).id, 'local')
assert.equal(initialWorkspace('?runtime=server', true, { origin: 'local', id: 'pc-id' }).id, 'public')
assert.equal(initialWorkspace('?space=server%3Ateam-id&runtime=local', true, savedTeam).id, 'team-id')
assert.equal(initialWorkspace('', true, savedTeam).id, 'team-id')
assert.equal(initialWorkspace('', true, { origin: 'local', id: 123 }).id, 'local')
for (const [pathname, search] of [
  ['/', ''], ['/', '?runtime=server'], ['/', '?space=local%3Apc-id'], ['/', '?space=server%3Ateam-id'],
  ['/unknown', '?space=local%3Apc-id'], ['/flows/id/unknown', '?space=server%3Apublic'],
]) {
  const target = workspaceLocation(pathname, search, '#details')
  assert.equal(target.pathname, '/flows')
  assert.equal(target.search, search)
  assert.equal(target.hash, '#details')
  // Either effect may finish last; both the route redirect and query normalizer converge on /flows.
  const canonicalSearch = new URLSearchParams(search)
  if (!canonicalSearch.has('space')) canonicalSearch.set('space', 'local:pc-id')
  const parentTarget = workspaceLocation(pathname, canonicalSearch.toString())
  assert.equal(parentTarget.pathname, target.pathname)
  assert.equal(workspaceLocation(parentTarget.pathname, parentTarget.search).pathname, '/flows')
}
for (const pattern of Object.values(routePaths)) {
  const pathname = pattern.replace(':id', 'resource-id')
  const target = workspaceLocation(pathname, '?space=server%3Ateam-id&folder=folder-id')
  assert.equal(target.pathname, pathname)
  assert.equal(target.search, '?space=server%3Ateam-id&folder=folder-id')
}
console.log('PASS: fresh root ticket, root with local/server space, unknown route, effect target convergence, deep links and query/hash preservation')
const effects = [], moves = []
let pcId = 'local'
const providerExports = {}
const providerReact = { createContext: () => ({ Provider: 'provider' }), useMemo: make => make(), useCallback: fn => fn, useRef: value => ({ current: value }), useState: () => [{ origin: 'local', id: 'local' }, () => {}], useEffect: effect => effects.push(effect) }
const providerModules = {
  react: providerReact, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
  'react-router-dom': { useLocation: () => ({ pathname: '/mocks', search: '?space=local%3Alocal&serverSpace=public', hash: '' }), useNavigate: () => (...args) => moves.push(args) },
  '@tanstack/react-query': { hashKey: JSON.stringify, QueryClient: class {}, QueryClientProvider: 'query-provider', useQuery: ({ queryKey }) => ({ data: queryKey[0] === 'desktop' ? { connected: true, login: 'mock-dev', serverUrl: 'http://mock.test' } : queryKey[1] === 'local' ? [{ id: pcId, name: '내 PC', kind: 'PERSONAL', myRole: 'OWNER' }] : [], isLoading: false }) },
  '../auth/AuthContext': { useAuth: () => ({ desktop: {} }) }, '../auth/desktop': { desktopApi: {} },
  '../api/client': { createApi: () => ({ workspacesApi: { list: async () => [] } }), localApi: {}, serverApi: {} }, './routePaths': api, '../lib/frontendMock': { FRONTEND_MOCK: false },
}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/app/WorkspaceContext.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText.replaceAll('import.meta.hot', 'undefined'), { exports: providerExports, require: name => providerModules[name], URLSearchParams, window: { location: { origin: 'http://mock.test' } }, localStorage: { getItem: () => null, setItem() {} } })
providerExports.WorkspaceProvider({ children: null }); effects.splice(0).forEach(effect => effect())
assert.equal(moves.length, 0, 'already-canonical Mock local ID must not repeatedly replace history or cancel pending navigation')
pcId = 'real-pc'
providerExports.WorkspaceProvider({ children: null }); effects.splice(0).forEach(effect => effect())
assert.equal(moves.length, 1, 'a real desktop UUID still resolves the local alias once')
assert.match(moves[0][0].search, /local%3Areal-pc/)
console.log('PASS: actual provider leaves canonical local routes alone and still resolves desktop aliases')
