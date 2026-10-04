// Real route normalizer used by App redirects and WorkspaceProvider; no browser/backend/MCP traffic.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const api = {}
const source = fs.readFileSync(path.join(__dirname, '../src/app/routePaths.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
vm.runInNewContext(code, { exports: api, require })
const { workspaceLocation, routePaths } = api
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
