// UI catalog logic only: no backend or MCP traffic.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/lib/catalog.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const api = {}
vm.runInNewContext(code, { exports: api })
const { catalogPage, matchesCatalog, compareMocks } = api

assert.equal(matchesCatalog('결제 TEAM-48', ['결제 운영', 'team-48']), true)
assert.equal(matchesCatalog('결제 개발', ['결제 운영', 'team-48']), false)
assert.equal(matchesCatalog('ｈｔｔｐ', ['HTTP 결제']), true)
assert.equal(matchesCatalog('   ', ['아무 공간']), true)
const workspaces = Array.from({ length: 100 }, (_, i) => ({ id: `team-${i + 1}`, name: `워크스페이스 ${i + 1}` }))
assert.equal(workspaces.filter(w => matchesCatalog('워크스페이스 team-100', [w.name, w.id])).length, 1)
const ids = Array.from({ length: 240 }, (_, i) => i)
const paged = []
for (let i = 1; i <= catalogPage(240, 1, 25).pages; i++) {
  const page = catalogPage(240, i, 25)
  paged.push(...ids.slice(page.start, page.end))
}
assert.deepEqual(paged, ids)
assert.equal(catalogPage(2, 10, 25).page, 1)
assert.equal(catalogPage(0, 100, 25).end, 0)
assert.equal(catalogPage(240, 10, 25).end, 240)
const mocks = [{ id: '2', name: '결제 10', state: 'on' }, { id: '3', name: '결제 2', state: 'off' }, { id: '1', name: '결제 2', state: 'fail' }]
assert.deepEqual([...mocks].sort(compareMocks('name', s => s.state)).map(s => s.id), ['1', '3', '2'])
assert.deepEqual([...mocks].sort(compareMocks('state', s => s.state)).map(s => s.id), ['1', '2', '3'])
const selected = new Set([1, 29, 239])
const second = catalogPage(240, 2, 25)
assert.equal(ids.slice(second.start, second.end).filter(id => selected.has(id)).length, 1)
assert.equal(selected.size, 3)
console.log('PASS: 100-workspace search, normalized multi-term search, 240-row pagination without gaps, clamped pages, stable sorting, cross-page selection')
