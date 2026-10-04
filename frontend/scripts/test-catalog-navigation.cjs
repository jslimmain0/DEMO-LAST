// Actual navigation resolver + hook through a history harness. No browser/network/MCP.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
function load(file, modules = {}) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { exports, URLSearchParams, require: name => modules[name] ?? {} })
  return exports
}
const resolver = load('../src/lib/catalogNavigation.ts')
const scope = { scopeKey: 'server:https://example.test:alice:team', remoteKey: 'https://example.test:alice:true', current: { origin: 'server', id: 'team' } }
const state = { search: '결제 실패', sort: 'name', page: 3, size: 50, filter: 'all', kind: 'all' }
const link = resolver.catalogDetailLink('flows', 'flow-id', scope, '?space=server%3Ateam', state)
assert.equal(link.to, '/flows/flow-id?space=server%3Ateam')
const back = resolver.catalogReturnLink(link.state, 'flows', scope, 'flow-owned-folder')
assert.equal(back.to, '/flows?space=server%3Ateam', 'home search must not return to flow-owned folder')
assert.equal(back.state.catalog.view.search, '결제 실패')
assert.equal(back.state.catalog.view.page, 3)
const folderLink = resolver.catalogDetailLink('flows', 'flow-id', scope, '?folder=source-folder&space=server%3Ateam', state)
assert.equal(new URLSearchParams(resolver.catalogReturnLink(folderLink.state, 'flows', scope).to.split('?')[1]).get('folder'), 'source-folder')
for (const changed of [
  { ...scope, remoteKey: 'https://example.test:bob:true' },
  { ...scope, remoteKey: 'https://other.test:alice:true' },
  { ...scope, scopeKey: 'server:https://example.test:alice:other', current: { origin: 'server', id: 'other' } },
]) {
  const fallback = resolver.catalogReturnLink(link.state, 'flows', changed, 'owned')
  assert.equal(fallback.state.catalog, undefined)
  assert.equal(new URLSearchParams(fallback.to.split('?')[1]).get('folder'), 'owned')
  assert.equal(resolver.readCatalogView(back.state, 'flows', resolver.catalogIdentity(changed)).search, '')
}
assert.equal(resolver.catalogReturnLink(link.state, 'flows', { ...scope, remoteKey: 'https://example.test:alice:false' }).state.catalog.view.page, 3, 'connection availability does not change account identity')
assert.equal(new URLSearchParams(resolver.catalogReturnLink(null, 'flows', scope, 'owned').to.split('?')[1]).get('folder'), 'owned', 'direct entry uses flow folder')
for (const to of ['https://evil.test/flows?space=server%3Ateam', '/mocks?space=server%3Ateam', '/flows/other?space=server%3Ateam', '/flows?space=server%3Aother', '/flows?space=server%3Ateam&space=server%3Aother']) {
  assert.equal(resolver.catalogReturnLink({ catalogReturn: { ...link.state.catalogReturn, to } }, 'flows', scope).state.catalog, undefined, to)
}
console.log('PASS: home/folder round trip; direct entry; account/server/workspace boundaries; offline identity; internal return path validation')

let currentScope = scope
let history = [{ pathname: '/flows', search: '?space=server%3Ateam', hash: '', state: null, key: 1 }]
let index = 0, key = 1, ref
const location = () => history[index]
const navigate = (to, options = {}) => {
  const parsed = new URL(to, 'https://app.test')
  const entry = { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash, state: options.state, key: ++key }
  if (options.replace) history[index] = entry
  else { history = history.slice(0, index + 1); history.push(entry); index++ }
}
const hook = load('../src/lib/useCatalogNavigation.ts', {
  react: { useRef: initial => ref ?? (ref = { current: initial }) },
  'react-router-dom': { useLocation: location, useNavigate: () => navigate },
  '../app/WorkspaceContext': { useWorkspace: () => currentScope },
  './catalogNavigation': resolver,
})
let list = hook.useCatalogNavigation('flows')
list.update({ search: 'settlement', page: 1 })
list.update({ sort: 'name' }) // Same event before next render must merge, not lose search.
list = hook.useCatalogNavigation('flows')
assert.equal(list.view.search, 'settlement')
assert.equal(list.view.sort, 'name')
assert.equal(history.length, 1, 'typing replaces current entry, not one history entry per character')
list.update({ page: 2, size: 25 })
list = hook.useCatalogNavigation('flows')
const detail = list.detail('flow-2')
navigate(detail.to, { state: detail.state })
const returnLink = hook.useCatalogReturn('flows', 'unrelated-folder')
navigate(returnLink.to, { state: returnLink.state })
ref = undefined // List remount after detail.
list = hook.useCatalogNavigation('flows')
assert.equal(list.view.search, 'settlement')
assert.equal(list.view.page, 2)
index -= 2 // Native browser Back reaches the original list entry.
ref = undefined
list = hook.useCatalogNavigation('flows')
assert.equal(list.view.search, 'settlement')
assert.equal(list.view.page, 2)
currentScope = { ...scope, remoteKey: 'https://example.test:bob:true' }
assert.equal(hook.useCatalogNavigation('flows').view.search, '', 'history from another account is ignored')
console.log('PASS: actual hook merges batched updates, replaces history, restores detail return and browser Back, rejects old-account history')

currentScope = scope
history = [{ pathname: '/mocks', search: '?space=server%3Ateam', hash: '', state: null, key: ++key }]; index = 0; ref = undefined
let mocks = hook.useCatalogNavigation('mocks')
mocks.update({ search: '/notify', sort: 'port', filter: 'on', kind: 'HTTP', page: 2, size: 25 })
mocks = hook.useCatalogNavigation('mocks')
const mock = mocks.detail('mock-id')
navigate(mock.to, { state: mock.state })
const mockBack = hook.useCatalogReturn('mocks')
navigate(mockBack.to, { state: mockBack.state }); ref = undefined
mocks = hook.useCatalogNavigation('mocks')
assert.equal(mocks.view.search, '/notify')
assert.equal(mocks.view.sort, 'port')
assert.equal(mocks.view.filter, 'on')
assert.equal(mocks.view.kind, 'HTTP')
assert.equal(mocks.view.page, 2)
mocks.update({ search: '', page: 1 }); mocks.update({ filter: 'all', page: 1 }); mocks.update({ kind: 'all', page: 1 })
mocks = hook.useCatalogNavigation('mocks')
assert.equal(mocks.view.search, '')
assert.equal(mocks.view.filter, 'all')
assert.equal(mocks.view.kind, 'all')
const catalog = load('../src/lib/catalog.ts')
assert.equal(catalog.catalogPage(26, 99, 25).page, 2, 'deleted results clamp the restored page')
assert.equal(catalog.catalogPage(0, 99, 25).page, 1)
console.log('PASS: Mock search/sort/filter/page round trip, batched filter reset, stale-page clamp')
