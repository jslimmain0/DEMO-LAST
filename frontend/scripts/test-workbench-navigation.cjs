// Actual shell/location handlers. No backend, browser or external requests.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const jsx = (type, props) => ({ type, props })
const storage = new Map()
const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
const scope = {
  current: { id: 'team-a', name: '결제팀', kind: 'TEAM', origin: 'server', myRole: 'EDITOR' },
  workspaces: [{ id: 'pc-id', name: '개인 공간', kind: 'PERSONAL', origin: 'local' }, { id: 'public', name: '공용', kind: 'PUBLIC', origin: 'server', myRole: 'EDITOR' }, { id: 'team-a', name: '결제팀', kind: 'TEAM', origin: 'server', myRole: 'EDITOR' }],
  connected: true, remoteError: false, remoteKey: 'https://company:alice:true', scopeKey: 'server:https://company:alice:team-a', remoteLoading: false, login: 'alice',
  select: (...args) => selections.push(args), agentApi: () => ({ adminApi: {}, workspacesApi: { create: () => {} } }),
}
const selections = [], serverFilters = []
let serverLogins = 0
let location = { pathname: '/resources', search: '?tab=secrets' }, desktop = {}, cursor = 0
const states = []
const modules = {
  react: { useState: initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] }, useMemo: callback => callback(), useEffect: callback => callback() },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'react-router-dom': { Link: 'link', useLocation: () => location },
  '@tanstack/react-query': { useQuery: () => ({ data: { admin: true, pendingCount: 1 } }) },
  './WorkspaceContext': { useWorkspace: () => scope },
  '../app/WorkspaceContext': { useWorkspace: () => scope },
  '../auth/AuthContext': { useAuth: () => ({ desktop, me: { username: 'alice' }, logout: () => {} }) },
  '../auth/desktop': { desktopApi: { login: () => { serverLogins++ } } },
  '../design/theme': { getTheme: () => 'light', toggleTheme: () => 'dark' },
  '../lib/frontendMock': { FRONTEND_MOCK: false },
  '../components/AppIcon': { AppIcon: 'icon' }, './AppIcon': { AppIcon: 'icon' },
}
function load(file) {
  const exported = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports: exported, require: name => modules[name] ?? {}, localStorage, URLSearchParams, window: { location: { origin: 'http://localhost' } } })
  return exported
}
modules['../lib/workspaceNavigation'] = load('lib/workspaceNavigation.ts')
modules['./workspaceNavigation'] = modules['../lib/workspaceNavigation']
modules['./catalogNavigation'] = load('lib/catalogNavigation.ts')
modules['../lib/workbenchNavigation'] = load('lib/workbenchNavigation.ts')
const { AppShellTier1 } = load('app/AppShell.tsx')
const { ResourceLocationBar } = load('components/ResourceLocationBar.tsx')
function walk(node, predicate, result = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, result))
  else if (node && typeof node === 'object') { if (predicate(node)) result.push(node); walk(node.props?.children, predicate, result) }
  return result
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node && typeof node === 'object') return text(node.props?.children)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}
const renderShell = () => { cursor = 0; return AppShellTier1({ children: '작업면', sidebarExtra: 'MOCK_NAVIGATOR' }) }
let tree = renderShell()
const links = walk(tree, node => node.type === 'link')
const link = label => links.find(node => text(node) === label)
assert.equal(walk(tree, node => node.type === 'link' && node.props['aria-label'] === '내 PC 워크플로')[0].props.to, '/flows?space=local%3Apc-id')
for (const label of ['시크릿', '프로토콜', '플러그인']) assert.equal(new URLSearchParams(link(label).props.to.split('?')[1]).get('space'), 'server:team-a', 'central catalogs retain workflow context while their APIs use public')
assert.equal(link('시크릿').props['aria-current'], 'page')
assert.equal(link('환경 변수').props['aria-current'], undefined, 'environment and secret tabs do not both appear active')
scope.current = { ...scope.current, id: 'pc-id', origin: 'local' }
scope.connected = false
tree = renderShell()
assert.equal(walk(tree, node => node.type === 'link' && text(node) === '플러그인').length, 1, 'central resources stay discoverable from PC/offline')
assert.match(text(tree), /내 PC에서 작업 중/)
location = { pathname: '/mocks/server-id', search: '' }
tree = renderShell()
assert.equal(walk(tree, node => node.props?.className === 'fl-sidebar-folders' && text(node) === 'MOCK_NAVIGATOR').length, 1, 'Mock detail receives one contextual navigator')

tree = ResourceLocationBar({})
const pc = walk(tree, node => node.type === 'button' && text(node) === '내 PC')[0]
assert.ok(pc)
assert.notEqual(pc.props.disabled, true, 'server disconnection never blocks PC entry')
pc.props.onClick()
assert.deepEqual(selections.pop(), ['pc-id', 'local'])
assert.equal(walk(tree, node => node.type === 'select')[0].props.disabled, true)
scope.connected = true
tree = ResourceLocationBar({})
walk(tree, node => node.type === 'select')[0].props.onChange({ target: { value: 'team-a' } })
assert.deepEqual(selections.pop(), ['team-a', 'server'])
tree = ResourceLocationBar({ combined: true, serverWorkspaceId: '', onServerWorkspaceChange: id => serverFilters.push(id) })
assert.match(text(tree), /내 PC항상 표시/)
assert.equal(walk(tree, node => node.type === 'button' && text(node) === '내 PC').length, 0)
const server = walk(tree, node => node.type === 'select')[0]
assert.equal(walk(server, node => node.type === 'option' && node.props.value === '').length, 1)
server.props.onChange({ target: { value: 'team-a' } })
server.props.onChange({ target: { value: '' } })
assert.deepEqual(serverFilters, ['team-a', ''])
assert.equal(selections.length, 0, 'combined server filter never changes global context or removes PC')
console.log('PASS: PC entry stays fixed, central menus target public, resource tabs highlight independently, Mock navigator slot survives')
console.log('PASS: location handlers respect origin/offline; combined filtering leaves PC/global context untouched')

modules['../app/AppShell'] = { AppShellTier1: 'shell' }
modules['../lib/catalog'] = load('lib/catalog.ts')
modules['@tanstack/react-query'] = {
  useQuery: config => ({ data: config.queryKey[0] === 'desktop' ? { serverUrl: 'https://company' } : { myStatus: 'APPROVED' } }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
}
modules['../components/toast'] = { toast: () => {} }
const { Workspaces } = load('routes/Workspaces.tsx')
scope.connected = false
states.length = 0; cursor = 0
tree = Workspaces()
assert.equal(walk(tree, node => node.props?.className === 'fl-personal-space').length, 1)
assert.equal(walk(tree, node => node.props?.className === 'fl-library-toolbar').length, 0, 'offline server does not show an empty search/table')
walk(tree, node => node.type === 'button' && text(node).includes('개인 워크플로'))[0].props.onClick()
assert.deepEqual(selections.pop(), ['pc-id', 'local'])
walk(tree, node => node.type === 'button' && text(node) === '서버 로그인')[0].props.onClick()
assert.equal(serverLogins, 1)
scope.connected = true; cursor = 0
tree = Workspaces()
assert.equal(walk(tree, node => node.props?.className === 'fl-personal-space').length, 1, 'server library keeps a fixed PC entry')
assert.equal(walk(tree, node => node.type === 'button' && text(node) === '워크플로 열기 →').length, 2)
console.log('PASS: server-space browsing preserves PC access and separates disconnected login from empty catalogs')

scope.current = { id: 'pc-id', origin: 'local', name: '개인 공간' }
scope.scopeKey = 'local:pc:pc-id'
scope.remoteKey = 'https://company:alice:true'
const view = { search: '결제', sort: 'name', page: 2, size: 25, filter: 'all', kind: 'all' }
location = { pathname: '/flows', search: '?space=local%3Apc-id&folder=payments', state: modules['./catalogNavigation'].catalogState({}, 'flows', modules['./catalogNavigation'].catalogIdentity(scope), view) }
renderShell()
scope.current = { id: 'public', origin: 'server', name: '공용' }; scope.scopeKey = 'server:https://company:alice:public'
location = { pathname: '/protocols', search: '?space=server%3Apublic' }
tree = renderShell()
const flowLink = walk(tree, node => node.type === 'link' && node.props['aria-label'] === '워크플로')[0]
assert.equal(flowLink.props.to, '/flows?space=local%3Apc-id&folder=payments')
assert.equal(flowLink.props.state.catalog.view.search, '결제')
assert.equal(flowLink.props.state.catalog.view.page, 2, 'central resource visits retain workflow list search/pagination')
scope.current = { id: 'team-a', origin: 'server', name: '결제팀' }; scope.scopeKey = 'server:https://company:alice:team-a'
location = { pathname: '/flows', search: '?space=server%3Ateam-a&folder=server-folder' }
renderShell()
location = { pathname: '/plugins', search: '?space=server%3Apublic' }
scope.remoteKey = 'https://company:bob:true'; scope.scopeKey = 'server:https://company:bob:public'
tree = renderShell()
assert.equal(walk(tree, node => node.type === 'link' && node.props['aria-label'] === '워크플로')[0].props.to, '/flows?space=local%3Apc-id&folder=payments', 'another account does not inherit the previous remote location but retains PC')
scope.remoteKey = 'https://other:alice:true'; scope.scopeKey = 'server:https://other:alice:public'
tree = renderShell()
assert.equal(walk(tree, node => node.type === 'link' && node.props['aria-label'] === '워크플로')[0].props.to, '/flows?space=local%3Apc-id&folder=payments', 'another server does not inherit previous team location')
console.log('PASS: central-resource round trip retains PC workflow folder/search/page; account/server changes reject remote positions')

scope.remoteKey = 'https://company:alice:true'; scope.current = { id: 'pc-id', origin: 'local' }; scope.scopeKey = 'local:pc:pc-id'
location = { pathname: '/resources', search: '?tab=environments&space=local%3Apc-id' }; renderShell()
scope.current = { id: 'public', origin: 'server' }; scope.scopeKey = 'server:https://company:alice:public'
location = { pathname: '/resources', search: '?tab=secrets&space=server%3Apublic' }; tree = renderShell()
assert.equal(new URLSearchParams(walk(tree, node => node.type === 'link' && node.props['aria-label'] === '환경 변수')[0].props.to.split('?')[1]).get('space'), 'local:pc-id', 'secrets do not overwrite environment location')
scope.current = { id: 'team-a', origin: 'server' }; scope.scopeKey = 'server:https://company:alice:team-a'
location = { pathname: '/executions', search: '?space=server%3Ateam-a' }; renderShell()
location = { pathname: '/plugins', search: '?space=server%3Apublic' }; tree = renderShell()
assert.equal(walk(tree, node => node.type === 'link' && node.props['aria-label'] === '실행 이력')[0].props.to, '/executions?space=server%3Ateam-a')
storage.set('fl:workspace-navigation:https://company:alice:view:flows', JSON.stringify({ origin: 'server', link: { to: '//example.invalid/flows?space=server:team-a' } }))
tree = renderShell()
assert.match(walk(tree, node => node.type === 'link' && node.props['aria-label'] === '워크플로')[0].props.to, /^\/flows\?space=local/)
console.log('PASS: environments/history retain independent positions; malformed stored destinations are rejected')

scope.current = { id: 'team-a', origin: 'server' }; scope.scopeKey = 'server:https://company:alice:team-a'
const mockView = { ...view, kind: 'TCP', sort: 'port', filter: 'fail', page: 3 }
location = { pathname: '/mocks', search: '?space=server%3Ateam-a&serverSpace=payments', state: modules['./catalogNavigation'].catalogState({}, 'mocks', modules['./catalogNavigation'].catalogIdentity(scope, 'mocks'), mockView) }
renderShell()
const mockDetail = modules['./catalogNavigation'].catalogDetailLink('mocks', 'pc-mock', scope, location.search, mockView, { origin: 'local', id: 'pc-id' })
scope.current = { id: 'pc-id', origin: 'local' }; scope.scopeKey = 'local:pc:pc-id'
location = { pathname: '/mocks/pc-mock', search: '?space=local%3Apc-id', state: mockDetail.state }
renderShell()
location = { pathname: '/protocols', search: '?space=server%3Apublic' }
scope.current = { id: 'public', origin: 'server' }; scope.scopeKey = 'server:https://company:alice:public'
tree = renderShell()
const mockMenu = walk(tree, node => node.type === 'link' && node.props['aria-label'] === 'Mock')[0]
assert.equal(mockMenu.props.to, '/mocks?space=server%3Ateam-a&serverSpace=payments')
assert.equal(mockMenu.props.state.catalog.view.kind, 'TCP')
assert.equal(mockMenu.props.state.catalog.view.page, 3)
scope.remoteKey = 'https://company:bob:true'
tree = renderShell()
const freshMockMenu = walk(tree, node => node.type === 'link' && node.props['aria-label'] === 'Mock')[0]
assert.equal(new URLSearchParams(freshMockMenu.props.to.split('?')[1]).has('serverSpace'), false, 'another account does not inherit server Mock filters through sidebar')
assert.equal(freshMockMenu.props.state, undefined)
console.log('PASS: sidebar Mock menu preserves cross-origin unified catalog filters and rejects another account filter state')

modules['../lib/frontendMock'].FRONTEND_MOCK = true
scope.current = { id: 'pc-id', origin: 'local' }; scope.scopeKey = 'local:pc:pc-id'
scope.remoteKey = 'https://company:alice:false'; scope.connected = false
location = { pathname: '/flows', search: '?space=local%3Apc-id&folder=offline-drafts', state: modules['./catalogNavigation'].catalogState({}, 'flows', modules['./catalogNavigation'].catalogIdentity(scope), view) }
tree = renderShell()
const commonLinks = walk(tree, node => node.type === 'link' && ['시크릿', '프로토콜', '플러그인'].includes(node.props['aria-label']))
assert.equal(commonLinks.length, 3)
for (const item of commonLinks) assert.equal(new URLSearchParams(item.props.to.split('?')[1]).get('space'), 'local:pc-id', 'Mock common-resource browsing retains the owner scope while its API uses the central catalog')
assert.equal(new URLSearchParams(walk(tree, node => node.type === 'link' && node.props['aria-label'] === '서버 공간 탐색')[0].props.to.split('?')[1]).get('space'), 'local:pc-id')
const protocolHref = commonLinks.find(item => item.props['aria-label'] === '프로토콜').props.to
const protocolUrl = new URL(protocolHref, 'http://localhost')
location = { pathname: protocolUrl.pathname, search: protocolUrl.search }
tree = renderShell()
assert.equal(scope.current.origin, 'local')
const offlineWorkflow = walk(tree, node => node.type === 'link' && node.props['aria-label'] === '워크플로')[0]
assert.equal(offlineWorkflow.props.to, '/flows?space=local%3Apc-id&folder=offline-drafts')
assert.equal(offlineWorkflow.props.state.catalog.view.search, '결제')
assert.equal(offlineWorkflow.props.state.catalog.view.page, 2)
modules['../lib/frontendMock'].FRONTEND_MOCK = false
tree = renderShell()
for (const item of walk(tree, node => node.type === 'link' && ['시크릿', '프로토콜', '플러그인'].includes(node.props['aria-label']))) assert.equal(new URLSearchParams(item.props.to.split('?')[1]).get('space'), 'local:pc-id', 'production common links retain the PC workflow context while their APIs use public')
console.log('PASS: Mock and production common menus keep PC scope and restore workflow folder/search/page')
