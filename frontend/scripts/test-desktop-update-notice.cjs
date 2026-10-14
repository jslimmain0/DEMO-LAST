const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const jsx = (type, props) => ({ type, props })
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
function walk(node, match, rows = []) { if (Array.isArray(node)) node.forEach(child => walk(child, match, rows)); else if (node && typeof node === 'object') { if (match(node)) rows.push(node); walk(node.props?.children, match, rows) } return rows }
function load(file, modules, globals) {
  const exports = {}
  const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: id => modules[id] ?? {}, ...globals })
  return exports
}
function fixture() {
  const stored = new Map(), listeners = new Map(), timers = new Map(), mutations = [], calls = [], toasts = [], effects = []
  let index = 0, now = 1_000_000, queryOptions, opened = 0
  const states = [], globals = {
    Date: class extends Date { static now() { return now } }, Event: class { constructor(type) { this.type = type } },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    window: { addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener: type => listeners.delete(type), dispatchEvent: event => listeners.get(event.type)?.(), setInterval: fn => { const id = timers.size + 1; timers.set(id, fn); return id }, clearInterval: id => timers.delete(id) },
  }
  const prefs = load('lib/desktopUpdateNotice.ts', {}, globals)
  const auth = { desktop: { serverUrl: 'https://company.example', connected: true, login: 'synthetic-user' } }
  const query = { data: { phase: 'available', currentVersion: '1.0.0', availableVersion: '1.1.0', releaseNotes: '합성 변경 내용', totalBytes: 10, downloadedBytes: 0, message: '새 업데이트가 있습니다' }, isError: false }
  const react = {
    useState: initial => { const id = index++; if (!(id in states)) states[id] = typeof initial === 'function' ? initial() : initial; return [states[id], value => { states[id] = typeof value === 'function' ? value(states[id]) : value }] },
    useEffect: effect => { const id = index++; if (!(id in states)) { states[id] = true; effects.push(effect) } },
  }
  const modules = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../auth/AuthContext': { useAuth: () => auth },
    '../auth/desktop': { desktopApi: Object.fromEntries(['updateStatus', 'checkUpdate', 'downloadUpdate', 'openUpdateWindow', 'login'].map(action => [action, () => { calls.push(action); return query.data }])) },
    '../lib/desktopUpdateNotice': prefs, '../design/ui': { ui: {} }, './ActionButton': { ActionButton: 'action' }, './toast': { toast: value => toasts.push(value) },
    '@tanstack/react-query': { useQuery: options => { queryOptions = options; return query }, useQueryClient: () => ({ setQueryData() {} }), useMutation: options => { mutations.push(options); return { mutate: options.mutationFn, isPending: false } } },
  }
  const { DesktopUpdateNotice } = load('components/DesktopUpdateNotice.tsx', modules, globals)
  const { DesktopUpdateCard } = load('components/DesktopUpdateCard.tsx', modules, globals)
  const render = () => { index = 0; const tree = DesktopUpdateNotice({ onOpen: () => opened++ }); effects.splice(0).forEach(effect => effect()); return tree }
  return { prefs, globals, auth, query, stored, calls, toasts, states, mutations, render, card: DesktopUpdateCard, get options() { return queryOptions }, get opened() { return opened }, tick: ms => { now += ms; timers.forEach(fn => fn()) } }
}

test('desktop update notice is global status-only and opens review without downloading or installing', () => {
  const f = fixture(), tree = f.render()
  assert.equal(f.options.enabled, true)
  assert.equal(f.options.refetchInterval, 60_000)
  assert.equal(f.options.refetchIntervalInBackground, false)
  assert.equal(f.options.retry, false)
  assert.match(text(tree), /새 버전 1\.1\.0/)
  walk(tree, node => node.props?.['aria-label']?.includes('업데이트 보기'))[0].props.onClick()
  assert.equal(f.opened, 1)
  assert.deepEqual(f.calls, [], 'an update announcement never installs, downloads or logs out')
  f.query.isError = true
  assert.equal(f.render(), null, 'failed background lookup never presents stale availability or blocks personal work')
  f.auth.desktop = undefined
  assert.equal(f.render(), null)
  assert.equal(f.options.enabled, false, 'server browser does not query PC update APIs')
})

test('notices can be deferred for one day or hidden per server and release, then restored from settings', () => {
  const f = fixture()
  let tree = f.render()
  walk(tree, node => node.type === 'button' && text(node) === '내일 다시 알림')[0].props.onClick()
  assert.equal(f.states[0], 1, 'same-millisecond preference events still trigger a render')
  assert.equal(f.render(), null)
  f.tick(86_400_001)
  tree = f.render(); assert.match(text(tree), /새 버전/)
  walk(tree, node => node.type === 'button' && text(node) === '이번 버전 숨김')[0].props.onClick()
  assert.equal(f.render(), null)
  f.tick(86_400_001); assert.equal(f.render(), null)
  f.query.data.availableVersion = '1.2.0'; assert.match(text(f.render()), /1\.2\.0/)
  f.query.data.availableVersion = '1.1.0'; f.auth.desktop.serverUrl = 'https://other.example'
  assert.match(text(f.render()), /1\.1\.0/)
  f.auth.desktop.serverUrl = 'https://company.example'; assert.equal(f.render(), null)
  const card = f.card()
  walk(card, node => node.type === 'action' && text(node) === '이 버전 알림 다시 표시')[0].props.onClick()
  assert.match(text(f.render()), /새 버전/)
  assert.match(f.toasts[0], /다시 표시/)
  assert.deepEqual(f.calls, [])
})

test('confirmed installation points to company login while cancelled or failed updates never log out from the browser', () => {
  const f = fixture()
  f.query.data = { ...f.query.data, phase: 'current', currentVersion: '1.1.0', availableVersion: null, loginRequired: true }
  assert.match(text(f.render()), /업데이트 완료 · 다시 로그인/)
  const card = f.card()
  assert.match(text(card), /취소하거나 설치에 실패하면 기존 로그인/)
  walk(card, node => node.type === 'action' && text(node) === '회사 계정으로 다시 로그인')[0].props.onClick()
  assert.deepEqual(f.calls, ['login'])
  f.query.data.loginRequired = false
  assert.equal(f.render(), null)
  f.query.data.phase = 'error'
  assert.equal(f.render(), null)
  assert.equal(walk(f.card(), node => node.type === 'action' && text(node) === '회사 계정으로 다시 로그인').length, 0)
  assert.deepEqual(f.calls, ['login'])
})
