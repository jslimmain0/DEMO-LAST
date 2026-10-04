// Actual guard component with router/browser boundary mocks; no network/MCP.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const refs = []; let cursor = 0, predicate, contextValue
const listeners = []; const navigations = []
const blocker = { state: 'unblocked', reset() { this.state = 'unblocked' }, proceed() { this.state = 'proceeding' } }
const runtime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
const modules = {
  react: { createContext: () => ({ Provider: 'provider' }), useCallback: fn => fn, useContext: () => contextValue, useRef: initial => refs[cursor++] ?? (refs[cursor - 1] = { current: initial }), useState: () => [0, () => {}], useEffect: effect => effect() },
  'react/jsx-runtime': runtime,
  'react-router-dom': { useBlocker: fn => { predicate = fn; return blocker }, useNavigate: () => (to, options) => { const blocked = predicate({ currentLocation: { pathname: '/mocks/a', search: '?space=local:pc', hash: '' }, nextLocation: { pathname: to.split('?')[0], search: to.includes('?') ? '?' + to.split('?')[1] : '', hash: '' } }); navigations.push({ to, options, blocked }) } },
}
const exportsObject = {}
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/UnsavedNavigation.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
vm.runInNewContext(code, { exports: exportsObject, require: name => modules[name] ?? {}, window: { addEventListener: (_name, listener) => listeners.push(listener), removeEventListener: () => {} } })
function render() { cursor = 0; const tree = exportsObject.UnsavedNavigationProvider({ children: 'editor' }); contextValue = tree.props.value; return tree }
const location = (pathname, search = '?space=local:pc') => ({ pathname, search, hash: '' })
const transition = { currentLocation: location('/mocks/a'), nextLocation: location('/flows') }
let tree = render(); const key = Symbol('mock')
assert.equal(predicate(transition), false)
contextValue.register(key, { dirty: true, label: 'Mock' }); render()
assert.equal(predicate(transition), true)
assert.equal(predicate({ currentLocation: location('/mocks/a'), nextLocation: location('/mocks/a') }), false, 'same URL history state updates do not discard editor')
assert.equal(predicate({ currentLocation: location('/mocks/a'), nextLocation: location('/mocks/a', '?space=server:team') }), true, 'space changes are blocked')
let prevented = false; listeners[0]({ preventDefault: () => { prevented = true } }); assert.equal(prevented, true)
contextValue.navigateSaved('/mocks/created?space=local:pc', { replace: true })
assert.equal(navigations[0].blocked, false, 'saved identity normalization is permitted once')
assert.equal(predicate(transition), true, 'saved navigation does not disable later guards')
contextValue.register(key, { dirty: true, saving: true }); blocker.state = 'blocked'; tree = render()
const modal = tree.props.children[1]
assert.equal(modal.props.children[2].props.children[1], false, 'saving has no discard/proceed action')
modal.props.onClose(); assert.equal(blocker.state, 'unblocked')
contextValue.register(key, { dirty: true, blockedReason: '환경 변수 저장 실패' }); blocker.state = 'blocked'; tree = render()
assert.equal(tree.props.children[1].props.children[2].props.children[1], false, 'failed automatic saves cannot be silently discarded')
contextValue.register(key, null); render(); assert.equal(predicate(transition), false)
console.log('PASS: actual guard dirty navigation/space/beforeunload, saved-only bypass, saving blocks discard, cancel and cleanup')
