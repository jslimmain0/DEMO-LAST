// Run: node frontend/scripts/test-executions.cjs. Actual screen rendering/handlers; no network or MCP.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const states = []
let cursor = 0, response = [], mutations = [], requestError = null, retries = 0
const jsx = (type, props) => ({ type, props })
const scope = { current: { id: 'team', origin: 'server', name: '팀' }, workspaces: [{ id: 'team', name: '팀', kind: 'TEAM' }], select: () => {} }
const apiError = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/apiError.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: apiError })
const modules = {
  react: { useState: initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] } },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  '@tanstack/react-query': { useQuery: () => ({ data: response, isLoading: false, isError: !!requestError, error: requestError, refetch: () => { retries++ } }), useMutation: () => ({ mutate: id => mutations.push(id), isPending: false }), useQueryClient: () => ({}) },
  '../app/WorkspaceContext': { useApi: () => ({ runsApi: {} }), useWorkspace: () => scope },
  'react-router-dom': { Link: 'link' },
  '../app/AppShell': { AppShellTier1: 'shell' },
  '../components/StatusBadge': { StatusBadge: 'status' },
  '../lib/format': { relTime: () => '지금', duration: value => String(value) },
  '../lib/apiError': apiError,
}
const exported = {}
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/routes/Executions.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
vm.runInNewContext(code, { exports: exported, require: name => modules[name] ?? {} })
const render = () => { cursor = 0; return exported.Executions() }
function walk(node, predicate, result = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, predicate, result) }
  else if (node && typeof node === 'object') { if (predicate(node)) result.push(node); walk(node.props?.children, predicate, result) }
  return result
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node && typeof node === 'object') return text(node.props?.children)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}
const entry = (id, status, flowName) => ({ id, flowId: 'flow', flowName, status, trigger: 'MANUAL', startedAt: '2026-10-03T00:00:00Z' })
response = [entry('failed-a', 'FAILED', 'failure-notification'), entry('failed-b', 'FAILED', 'failure-notification'), ...Array.from({ length: 34 }, (_, index) => entry(`ok-${index}`, 'SUCCEEDED', 'other'))]
render()
states[3] = 'failure-notification'
let tree = render()
const heading = walk(tree, node => node.props?.className === 'fl-execution-heading')[0]
assert.match(text(heading), /2건/)
assert.match(text(heading), /✕ 2/)
assert.doesNotMatch(text(heading), /✓/)
const rows = walk(tree, node => node.props?.className?.split(' ').includes('fl-flow-card'))
assert.equal(rows.length, 2)
const detail = walk(rows[0], node => node.type === 'button' && node.props['aria-label']?.includes('실행 결과 상세 보기'))[0]
assert.ok(detail, 'result-reading action is a native keyboard-operable button')
assert.equal(walk(detail, node => node !== detail && ['button', 'link'].includes(node.type)).length, 0, 'detail control has no nested actions')
function click(control, row) { let stopped = false; control.props.onClick({ stopPropagation: () => { stopped = true } }); if (!stopped) row.props.onClick(); return stopped }
assert.equal(click(detail, rows[0]), true)
assert.equal(states[4], 'failed-a')
assert.equal(mutations.length, 0, 'reading a result never reruns it')
states[4] = null
const rerun = walk(rows[0], node => node.type === 'button' && text(node).includes('재실행'))[0]
assert.equal(click(rerun, rows[0]), true)
assert.deepEqual(mutations, ['failed-a'])
assert.equal(states[4], null, 'rerun click does not also open result details')
const edit = walk(rows[0], node => node.type === 'link')[0]
assert.equal(click(edit, rows[0]), true)
assert.equal(edit.props.to, '/flows/flow')
assert.equal(states[4], null)
states[3] = 'does-not-exist'
tree = render()
assert.match(text(tree), /이 조건에 해당하는 실행이 없습니다/)
assert.doesNotMatch(text(tree), /아직 실행 이력이 없습니다/)
const reset = walk(tree, node => node.type === 'button' && text(node) === '필터 해제')[0]
reset.props.onClick()
assert.deepEqual(states.slice(1, 4), ['all', 'all', ''])
response = []
states[1] = 'FAILED'
tree = render()
assert.match(text(tree), /이 조건에 해당하는 실행이 없습니다/)
assert.doesNotMatch(text(tree), /아직 실행 이력이 없습니다/, 'empty server-filtered response is not first-use history')
states[1] = 'all'; states[2] = '7d'
assert.doesNotMatch(text(render()), /아직 실행 이력이 없습니다/)
states[2] = 'all'
tree = render()
assert.match(text(tree), /아직 실행 이력이 없습니다/)
assert.doesNotMatch(text(tree), /이 조건에 해당하는 실행이 없습니다/)
requestError = { response: { data: { message: '이 공간에 접근할 권한이 없습니다.' } } }
tree = render()
assert.match(text(tree), /서버 공간의 실행 이력/)
assert.match(text(tree), /이 공간에 접근할 권한이 없습니다/)
scope.current.origin = 'local'
requestError = { code: 'ERR_NETWORK', message: 'Network Error' }
tree = render()
assert.match(text(tree), /개인 PC의 실행 이력/)
assert.match(text(tree), /연결 상태를 확인한 뒤 다시 시도/)
assert.doesNotMatch(text(tree), /18080|dev-all|Network Error|아직 실행 이력이 없습니다/)
walk(tree, node => node.type === 'button' && text(node) === '다시 시도')[0].props.onClick()
assert.equal(retries, 1)
console.log('PASS: filtered rows/counters agree; first-use/search/status/range empties are exclusive and reset works')
console.log('PASS: native result button reads without rerun; nested rerun/edit clicks remain separate')
console.log('PASS: history errors identify current runtime, preserve permission message, localize network failure, and retry')
