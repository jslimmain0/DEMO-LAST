// Actual TSX component handlers/output; mocked API only, no network/MCP.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
function load(file, modules) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports, require: name => modules[name] ?? {} })
  return exports
}
const values = []; let cursor = 0
const react = { useState: initial => { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next }] }, useMemo: make => make(), useEffect: () => {} }
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' }
const catalog = load('../src/lib/catalog.ts', {})
const calls = [], notifications = []; let failing = true, refreshes = 0
const api = { putUser: async (name, body) => { calls.push({ name, body }); if (name === 'beta' && failing) throw new Error('mock rejection') }, removeUser: async () => {} }
function AskDialog() {}; function Pagination() {}
const common = { react, 'react/jsx-runtime': jsx, '../app/WorkspaceContext': { useApi: () => ({ adminApi: api }) }, '@tanstack/react-query': { useMutation: () => ({ isPending: false }), useQueryClient: () => ({}) }, '../components/AskDialog': { AskDialog }, '../components/CatalogPagination': { CatalogPagination: Pagination }, '../components/toast': { toast: message => notifications.push(message) }, '../lib/apiError': { apiErrorMessage: String }, '../lib/catalog': catalog, '../lib/format': { relTime: () => '지금' } }
const component = load('../src/routes/AdminUsers.tsx', common)
const users = ['alpha', 'beta'].map(username => ({ username, status: 'PENDING', globalRole: 'MEMBER' }))
const props = { myName: 'admin', users, teams: [], loading: false, onRefresh: () => refreshes++, onBusyChange: () => {} }
let tree
function render() { cursor = 0; tree = component.AdminUsers(props); return tree }
function all(node, predicate, found = []) { if (!node || typeof node !== 'object') return found; if (predicate(node)) found.push(node); const children = node.props?.children; for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) all(child, predicate, found); return found }
function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); return (Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).map(text).join('') }
function button(label) { return all(tree, node => node.type === 'button' && text(node) === label)[0] }
function ask() { return all(tree, node => node.type === AskDialog)[0].props.spec }
async function confirm() { ask().onConfirm(); for (let i = 0; i < 12; i++) await Promise.resolve(); render() }
async function run() {
  render()
  button('현재 페이지의 가입 대기 선택 (2)').props.onClick(); render()
  all(tree, node => node.type === Pagination)[0].props.onSize(1); render()
  all(tree, node => node.type === Pagination)[0].props.onPage(2); render()
  assert.match(text(tree), /현재 페이지 밖 1명 포함/)
  assert.equal(all(tree, node => node.type === 'input' && node.props.type === 'checkbox')[0].props.checked, true)
  const search = all(tree, node => node.type === 'input' && node.props.type === 'search')[0]
  search.props.onChange({ target: { value: 'alpha' } }); render()
  assert.match(text(tree), /현재 페이지 밖 1명 포함/)
  button('선택한 신청 승인').props.onClick(); render()
  assert.match(ask().message, /페이지 밖 1명 포함/)
  assert.match(ask().message, /alpha, beta/)
  await confirm()
  assert.deepEqual(calls.map(call => call.name), ['alpha', 'beta'])
  assert.match(text(tree), /승인 성공 1명 · 실패 1명/)
  assert.match(text(tree), /beta.*실패한 신청은 선택을 유지/)
  assert.equal(values[6].size, 1); assert.equal(values[6].has('beta'), true)
  assert.equal(refreshes, 1)
  failing = false
  button('선택한 신청 승인').props.onClick(); render()
  assert.equal(ask().title, '선택한 가입 신청 1명 승인')
  await confirm()
  assert.deepEqual(calls.map(call => call.name), ['alpha', 'beta', 'beta'])
  assert.equal(values[6].size, 0)
  assert.match(text(tree), /승인 성공 1명 · 실패 0명/)
  assert.deepEqual(notifications, ['승인 성공 1명 · 실패 1명', '승인 성공 1명 · 실패 0명'])
  // Actual Admin route: non-admin and permission query error must not expose users.
  let permission = { isSuccess: true, data: { admin: false } }
  const admin = load('../src/routes/Admin.tsx', { ...common, '../app/WorkspaceContext': { useApi: () => ({ adminApi: { me: async () => {}, users: async () => {}, workspaces: async () => {} }, pluginsApi: { list: async () => [] } }), useWorkspace: () => ({ current: { origin: 'server' } }) }, '@tanstack/react-query': { useQueryClient: () => ({}), useQuery: ({ queryKey }) => queryKey[1] === 'me' ? permission : { data: [] } }, './AdminUsers': { AdminUsers: component.AdminUsers } })
  cursor = 0; const denied = admin.Admin()
  assert.match(text(denied), /관리자만 접근/)
  assert.equal(all(denied, node => node.type === component.AdminUsers).length, 0)
  permission = { isError: true }
  cursor = 0; const failed = admin.Admin()
  assert.match(text(failed), /관리 권한을 확인하지 못했습니다/)
  assert.equal(all(failed, node => node.type === component.AdminUsers).length, 0)
  console.log('PASS: actual AdminUsers partial approval, hidden selection, failed-only retry; actual Admin non-admin/error fail closed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
