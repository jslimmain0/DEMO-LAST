// Actual Mock list/row handlers with deferred API replies; no backend, browser or MCP calls.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const jsx = (type, props) => ({ type, props })
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
let rendering
const react = {
  useState(initial) {
    const i = rendering.index++
    const slot = rendering.slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }
    return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value }]
  },
  useRef(initial) { return react.useMemo(() => ({ current: initial }), []) },
  useMemo(make, deps) {
    const i = rendering.index++
    if (!rendering.slots[i] || !sameDeps(rendering.slots[i].deps, deps)) rendering.slots[i] = { value: make(), deps }
    return rendering.slots[i].value
  },
  useCallback(callback, deps) { return react.useMemo(() => callback, deps) },
  useEffect(effect, deps) {
    const i = rendering.index++, previous = rendering.slots[i]
    if (!previous || !sameDeps(previous.deps, deps)) {
      const slot = rendering.slots[i] = { deps }
      rendering.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() })
    }
  },
}
function renderer(component) {
  const state = { slots: [], index: 0, effects: [] }
  return () => {
    rendering = state; state.index = 0; state.effects = []
    const tree = component()
    rendering = null
    state.effects.forEach(effect => effect())
    return tree
  }
}
function walk(node, predicate, result = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, result))
  else if (node && typeof node === 'object') {
    if (predicate(node)) result.push(node)
    for (const key of ['children', 'actions', 'sidebarExtra']) walk(node.props?.[key], predicate, result)
  }
  return result
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node && typeof node === 'object') return text(node.props?.children)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}
const button = (tree, label) => walk(tree, node => node.type === 'button' && text(node).trim() === label)[0]
const field = (tree, label) => walk(tree, node => node.props?.['aria-label'] === label)[0]
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))
const timers = new Map()
let timerId = 0
const fireTimers = delay => {
  for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback() }
}
const writes = [], copied = [], slugChecks = []
const deleted = new Set(), deleteFailures = new Set(), deleteAttempts = [], toasts = []
const requests = [], requestOrder = [], navigations = []
const mock = workspaceId => ({ id: 'same-id', name: '같은 이름', slug: 'same-slug', workspaceId, kind: 'HTTP', enabled: false, readable: true, myRole: 'OWNER', routeLabels: [], routeCount: 0, currentVersion: 1, recentRequests: 0, unmatchedRequests: 0 })
const workspace = (id, kind) => ({ id, kind, name: id, mine: true, myRole: 'OWNER' })
const fleets = {
  local: { workspaces: [workspace('local', 'PERSONAL')], servers: [mock('local')], ports: [{ port: 18080, kind: 'HTTP', state: 'LISTENING', readable: true, count: 1 }, { port: 19000, kind: 'TCP', state: 'LISTENING', workspaceId: 'local', mockId: 'same-id', mockName: '같은 이름', readable: true, count: 1 }], httpPort: 18080, contextPath: '', generatedAt: '2026-10-12T00:00:00Z' },
  server: { workspaces: [workspace('public', 'PUBLIC'), workspace('team-b', 'TEAM')], servers: [mock('public')], ports: [{ port: 8080, kind: 'HTTP', state: 'LISTENING', readable: true, count: 1 }, { port: 19000, kind: 'TCP', state: 'LISTENING', workspaceId: 'public', mockId: 'same-id', mockName: '같은 이름', readable: true, count: 1 }], httpPort: 8080, contextPath: '/company', generatedAt: '2026-10-12T00:00:00Z' },
}
const apis = new Map()
function apiFor(origin, workspaceId) {
  const key = `${origin}:${workspaceId}`
  if (!apis.has(key)) apis.set(key, {
    environmentsApi: { list: () => [] },
    mockBaseUrl: (slug, _tenant, basePath) => `${origin === 'local' ? 'http://localhost:18080' : 'https://company.test:8080/company'}${basePath ?? `/mock/ws/${workspaceId}/${slug}`}`,
    mocksApi: {
      fleet: () => fleets[origin],
      update: async (id, body) => { writes.push({ origin, workspaceId, id, body }) },
      remove: async id => {
        const identity = `${origin}:${id}`
        deleteAttempts.push(identity)
        if (deleted.has(identity)) throw new Error('404: this Mock was already deleted')
        if (deleteFailures.delete(identity)) throw new Error('temporary server failure')
        deleted.add(identity)
      },
      slugCheck: slug => { const reply = deferred(); slugChecks.push({ origin, workspaceId, slug, ...reply }); return reply.promise },
    },
  })
  return apis.get(key)
}
const scope = {
  current: { origin: 'local', id: 'local' }, scopeKey: 'local:pc:local', remoteKey: 'company:alice:true', connected: true,
  workspaces: [{ ...workspace('local', 'PERSONAL'), origin: 'local' }, ...fleets.server.workspaces.map(w => ({ ...w, origin: 'server' }))],
  agentApi: apiFor,
}
const location = { pathname: '/mocks', search: '?space=local%3Alocal', state: { catalog: 'keep-list-context' } }
const modules = {
  react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-dom': { createPortal: node => node },
  'react-router-dom': {
    useNavigate: () => (...args) => navigations.push(args), useLocation: () => location,
    useSearchParams: () => [new URLSearchParams(location.search), (next, options) => {
      const value = typeof next === 'function' ? next(new URLSearchParams(location.search)) : next
      location.search = `?${value}`
      if (options?.state !== undefined) location.state = options.state
    }],
  },
  '@tanstack/react-query': {
    useQuery: ({ queryKey }) => ({ data: fleets[queryKey[1]], isFetching: false, isError: false }),
    useMutation: config => ({ isPending: false, mutate: async variables => {
      try { const result = await config.mutationFn(variables); config.onSuccess?.(result, variables); return result }
      catch (error) { config.onError?.(error); throw error }
    } }),
    useQueryClient: () => ({ invalidateQueries() {} }),
  },
  '../app/WorkspaceContext': { useWorkspace: () => scope, useApi: () => apiFor('local', 'local') },
  '../auth/AuthContext': { useAuth: () => ({ desktop: {}, me: { tenant: 'default' } }), usePermissions: () => ({ canEdit: true }) },
  '../components/PageHeader': { PageHeader: 'page-header' }, '../components/AppIcon': { AppIcon: 'icon' }, './AppIcon': { AppIcon: 'icon' },
  '../app/AppShell': { AppShellTier1: 'shell' }, '../components/AskDialog': { AskDialog: 'ask' },
  '../components/MockTransferDialog': { MockImportDialog: 'import', MockExportDialog: 'export' },
  '../components/MockNavigator': { MockNavigator: 'navigator' }, '../components/ResourceLocationBar': { ResourceLocationBar: 'location-bar' },
  '../components/toast': { toast: message => toasts.push(message) }, './toast': { toast: message => toasts.push(message) }, '../lib/apiError': { apiErrorMessage: error => error.message },
  '../canvas/nodeMeta': { METHOD_COLOR: {} }, '../lib/format': { relTime: () => '' }, './CatalogPagination': { CatalogPagination: 'pagination' },
  '../design/ui': { ui: {} },
  '../lib/frontendMock': { FRONTEND_MOCK: true },
  '../lib/useCatalogNavigation': { useCatalogNavigation: () => ({ view: { search: '', filter: 'all', kind: 'all', sort: 'name', page: 1, size: 25 }, update() {}, detail: () => ({ state: {} }) }) },
}
function load(file) {
  const exported = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, {
    exports: exported, require: name => { if (!(name in modules)) throw new Error(`Missing fixture module: ${name}`); return modules[name] },
    URL, URLSearchParams, structuredClone,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { clipboard: { writeText: async value => copied.push(value) } },
    window: { location: { hostname: 'localhost' }, addEventListener() {}, removeEventListener() {} },
    fetch: async (url, options) => { requestOrder.push('fetch'); requests.push({ url, options }); return { status: 200, ok: true, text: async () => 'ok', headers: { get: () => null } } },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id }, clearTimeout: id => timers.delete(id),
  })
  return exported
}
modules['../lib/catalog'] = load('lib/catalog.ts')
modules['../lib/mockCatalog'] = load('lib/mockCatalog.ts')
const inventory = modules['../components/MockInventory'] = load('components/MockInventory.tsx')
const { MockServers } = load('routes/MockServers.tsx')
const inventoryNode = tree => walk(tree, node => node.type === inventory.MockInventory)[0]

async function testAddressesAndMoves() {
  const render = renderer(MockServers)
  let tree = render(), props = inventoryNode(tree).props
  assert.deepEqual(Array.from(props.fleet.servers, s => s.id), ['local:same-id', 'server:same-id'])
  const inventoryTree = renderer(() => inventory.MockInventory(props))()
  const rows = walk(inventoryTree, node => typeof node.type === 'function' && node.type.name === 'InventoryRow')
  assert.equal(rows.length, 2)
  for (const row of rows) {
    const rowTree = renderer(() => row.type(row.props))()
    const origin = row.props.s.id.startsWith('local:') ? 'local' : 'server'
    const expected = apiFor(origin, origin === 'local' ? 'local' : 'public').mockBaseUrl('same-slug')
    assert.equal(walk(rowTree, node => node.type === 'span' && node.props.title === expected && text(node) === expected).length, 1, `${origin} row must show its own listener URL`)
    field(rowTree, '같은 이름 주소 복사').props.onClick({ stopPropagation() {} })
    await settle()
    assert.equal(copied.at(-1), expected, 'displayed and copied addresses must agree')
  }
  const portChips = walk(inventoryTree, node => typeof node.type === 'function' && node.type.name === 'PortChip')
  assert.equal(portChips.length, 4)
  for (const chip of portChips) {
    const chipTree = renderer(() => chip.type(chip.props))()
    const local = chip.props.p.origin === 'local'
    assert.match(text(chipTree), local ? /내 PC/ : /서버/, 'same-number ports must identify their host')
    assert.match(chipTree.props.title, local ? /localhost:/ : /company\.test:/)
    assert.match(chipTree.props['aria-label'], local ? /^내 PC 포트/ : /^서버 포트/)
    if (!local && chip.props.p.kind === 'HTTP') assert.match(chipTree.props.title, /:8080\/company/, 'a gateway without workspaceId retains the server context path')
  }
  const server = props.fleet.servers.find(s => s.id.startsWith('server:'))
  const local = props.fleet.servers.find(s => s.id.startsWith('local:'))
  props.onToggleSelect(server); props.onToggleSelect(local)
  tree = render()
  const moveTarget = field(tree, '선택 Mock을 이동할 워크스페이스')
  assert.equal(moveTarget.props.disabled, true, 'mixed-host selection must not offer a move')
  moveTarget.props.onChange({ target: { value: 'server:team-b' } })
  tree = render()
  const move = button(tree, '선택한 공간으로 이동')
  assert.equal(move.props.disabled, true)
  writes.length = 0
  await assert.rejects(move.props.onClick(), /위치|PC|서버|복제/)
  assert.equal(writes.length, 0, 'validate every selected host before the first update')
  inventoryNode(tree).props.onToggleSelect(local)
  tree = render()
  assert.equal(button(tree, '선택한 공간으로 이동').props.disabled, false)
  await button(tree, '선택한 공간으로 이동').props.onClick()
  assert.equal(JSON.stringify(writes), JSON.stringify([{ origin: 'server', workspaceId: 'public', id: 'same-id', body: { workspaceId: 'team-b' } }]), 'ordinary server move must still use its original host and raw ID')
  console.log('PASS: same-ID PC/server URLs and same-port labels remain distinct; mixed moves reject before writes; server moves work')
}

async function testPartialDeleteRetry() {
  deleted.clear(); deleteAttempts.length = 0; toasts.length = 0
  deleteFailures.add('server:same-id')
  const render = renderer(MockServers)
  let tree = render(), props = inventoryNode(tree).props
  props.onToggleSelect(props.fleet.servers.find(s => s.id.startsWith('local:')))
  props.onToggleSelect(props.fleet.servers.find(s => s.id.startsWith('server:')))
  tree = render()
  button(tree, '삭제').props.onClick()
  tree = render()
  const confirmation = walk(tree, node => node.type === 'ask')[0]
  await assert.rejects(confirmation.props.spec.onConfirm(), /1개 완료.*1개 미완료/)
  tree = render()
  assert.deepEqual(Array.from(inventoryNode(tree).props.selected), ['server:same-id'], 'completed deletes leave the selection before refetch')
  assert.match(toasts.at(-1), /1개 완료.*1개 미완료.*다시 시도/)
  button(tree, '삭제').props.onClick()
  tree = render()
  await walk(tree, node => node.type === 'ask')[0].props.spec.onConfirm()
  assert.deepEqual(deleteAttempts, ['local:same-id', 'server:same-id', 'server:same-id'], 'retry must not re-delete the completed PC Mock')
  assert.equal(inventoryNode(render()).props.selected.size, 0)
  assert.equal(deleted.size, 2)
  console.log('PASS: partial delete preserves only unfinished selection; retry completes without re-deleting successful items')
}

async function testStaleSlugReplies(rejectOld) {
  timers.clear(); slugChecks.length = 0
  const render = renderer(MockServers)
  let tree = render()
  button(tree, '+ HTTP Mock').props.onClick()
  tree = render()
  field(tree, 'slug').props.onChange({ target: { value: 'same-slug' } })
  render(); fireTimers(350)
  const previous = slugChecks[0]
  assert.equal(previous.origin, 'local')
  tree = render()
  field(tree, '만들 워크스페이스').props.onChange({ target: { value: 'server:public' } })
  render(); fireTimers(350)
  const current = slugChecks[1]
  assert.equal(current.origin, 'server')
  current.resolve({ available: !rejectOld }); await settle()
  const expected = rejectOld ? '✕ 사용 중' : '✓ 사용 가능'
  assert.ok(text(render()).includes(expected))
  if (rejectOld) previous.reject(new Error('old local request failed'))
  else previous.resolve({ available: false })
  await settle()
  tree = render()
  assert.ok(text(tree).includes(expected), 'an old-host reply must not change the current-host availability')
  assert.equal(button(tree, '만들기').props.disabled, rejectOld, 'create eligibility must follow only the latest host')
}

async function testEditorHeadersAndReplay() {
  let detailResult, retries = 0
  const environmentQueries = [], specWrites = []
  let rejectSpec = false
  modules['@tanstack/react-query'].useQuery = ({ queryKey, queryFn }) => {
    if (queryKey[0] === 'mock-server') return detailResult
    if (queryKey[0] === 'workspaces') return { data: scope.workspaces.filter(w => w.origin === scope.current.origin) }
    if (queryKey[0] === 'mock-state') return { data: { state: {} } }
    if (queryKey[0] === 'secrets') return { data: [{ name: 'COMMON', environment: null }, { name: 'SERVER_ONLY', environment: 'same' }] }
    if (queryKey[0] === 'mock-environments') { environmentQueries.push({ queryKey, queryFn }); return { isSuccess: true, data: [{ name: 'same', vars: queryKey[1] === 'local' ? { PC: 'yes' } : { SERVER: 'yes' } }] } }
    return { data: [] }
  }
  modules['../app/WorkspaceContext'].useApi = () => ({
    ...apiFor(scope.current.origin, scope.current.id), adminApi: { me() {} }, workspacesApi: { list() {} }, secretsApi: { list() {} }, environmentsApi: { list() {} },
  })
  modules['react-router-dom'].useParams = () => ({ id: 'same-id' })
  modules['../lib/useCatalogNavigation'].useCatalogReturn = () => ({ to: '/mocks?space=server%3Apublic', state: { catalog: 'return-list' } })
  Object.assign(modules, {
    '../components/AssistantLoginGate': { AssistantLoginGate: 'login-gate' }, '../components/MockAssistantPanel': { MockAssistantPanel: 'assistant' },
    '../components/MockCodecEditor': { MockCodecEditor: 'codec' }, '../components/MockRouteEditor': { RouteCard: 'route-card' },
    '../components/TcpMockEditor': { TcpConnPanel: 'tcp-connection', TcpLogPanel: 'tcp-log', TcpRuleDetail: 'tcp-rule', TcpSendPanel: 'tcp-send', tcpRuleSummary: () => '' },
    '../components/TcpMockSessions': { TcpMockSessions: 'tcp-sessions' },
    '../components/MockVersionHistoryDialog': { MockVersionHistoryDialog: 'versions' }, '../components/Modal': { Modal: 'modal' },
    '../components/UnsavedNavigation': { useUnsavedNavigation() {} }, '../components/AgentSettings': { AgentBadge: 'agent-badge' },
    '../lib/contrast': { useReadableInk: () => '#fff' }, '../lib/ids': { newId: () => 'new-id' },
    '../lib/mockCodecOps': { stepCount: () => ({ request: 0, response: 0 }) }, '../lib/mockOpenApi': {},
    '../lib/mockRequestLog': { findRouteIndex: () => -1, interestingHeaders: value => value },
    '../lib/mockSources': { applicableSecretNames: () => [], envKeys: () => [], mockSources: () => [] },
    '../lib/protocolSpec': {}, '../panels/TcpNodePanel': { useProtocol: () => ({}) }, './mock-editor.css': {},
  })
  modules['../lib/mockSources'] = load('lib/mockSources.ts')
  const { MockServerEditor } = load('routes/MockServerEditor.tsx')
  for (const origin of ['local', 'server']) apiFor(origin, origin === 'local' ? 'local' : 'public').mocksApi.updateSpec = async (id, spec) => { if (rejectSpec) throw new Error('서버 공통 프로토콜이 없습니다: private-legacy'); specWrites.push({ id, spec }) }
  let httpTree
  for (const [origin, kind, advertisedAddress] of [['local', 'TCP'], ['server', 'TCP'], ['server', 'TCP', '10.20.30.40:19000'], ['server', 'HTTP']]) {
    scope.current = { origin, id: origin === 'local' ? 'local' : 'public', name: origin === 'local' ? '내 PC' : '공용' }
    const detail = { id: 'same-id', workspaceId: scope.current.id, slug: 'same-slug', name: '같은 이름', kind, enabled: false, spec: kind === 'TCP' ? { tcp: { port: 19000, rules: [] } } : { routes: [] }, listener: advertisedAddress ? { advertisedAddress } : undefined }
    detailResult = { data: detail }
    const render = renderer(MockServerEditor)
    render(); const tree = render()
    const badge = walk(tree, node => node.type === 'agent-badge')[0]
    assert.equal(badge.props.agent, origin)
    assert.equal(badge.props.label, origin === 'local' ? '내 PC' : '서버 · 공용')
    const expected = kind === 'HTTP' ? apiFor(origin, scope.current.id).mockBaseUrl('same-slug') : advertisedAddress ?? `${origin === 'local' ? 'localhost' : 'company.test'}:19000`
    const addressButton = walk(tree, node => node.type === 'button' && node.props.title?.endsWith(`복사 — ${expected}`))[0]
    assert.ok(addressButton, `${origin} ${kind} header must expose its listener address`)
    assert.ok(text(addressButton).includes(expected))
    addressButton.props.onClick(); await settle()
    assert.equal(copied.at(-1), expected, 'header clipboard and displayed address must agree')
    if (kind === 'HTTP') httpTree = tree
    if (kind === 'HTTP') assert.equal(field(tree, '연결 세션'), undefined, 'HTTP navigation must not offer TCP sessions')
  }
  const permissions = modules['../auth/AuthContext'].usePermissions
  const originalScopeKey = scope.scopeKey
  try {
    for (const origin of ['local', 'server']) for (const canEdit of [true, false]) {
      modules['../auth/AuthContext'].usePermissions = () => ({ canEdit })
      scope.current = { origin, id: origin === 'local' ? 'local' : 'public', name: origin }
      scope.scopeKey = `${origin}:sessions-location`
      detailResult = { data: { id: 'same-id', name: 'TCP 배치 검증', slug: 'same-slug', workspaceId: scope.current.id, kind: 'TCP', enabled: true,
        spec: { tcp: { port: 19000, protocolId: 'p', rules: [{ id: 'rule-a', then: { mode: 'mock', fields: { value: 'A001' } } }] } } } }
      const render = renderer(MockServerEditor)
      render(); let tree = render()
      assert.equal(walk(tree, node => node.type === 'tcp-rule').length, 1, 'initial rule selection is preserved')
      assert.equal(walk(tree, node => node.type === 'tcp-sessions').length, 0, 'session polling is mounted only in its own menu')
      const writesBefore = writes.length, savesBefore = specWrites.length, navigationsBefore = navigations.length
      field(tree, '연결 세션').props.onClick(); tree = render()
      const sessionPanel = walk(tree, node => node.type === 'tcp-sessions')[0]
      assert.equal(sessionPanel.props.readOnly, !canEdit)
      assert.equal(sessionPanel.props.mockId, 'same-id')
      assert.equal(field(tree, '연결 세션').props['aria-current'], 'page')
      assert.equal(walk(tree, node => node.type === 'tcp-connection').length, 0)
      assert.equal(walk(tree, node => node.type === 'tcp-rule').length, 0)
      assert.equal(button(tree, '저장').props.disabled, true, 'menu navigation does not dirty the Mock')
      sessionPanel.props.onOpenConnection(); tree = render()
      assert.equal(field(tree, '연결 설정').props['aria-current'], 'page')
      assert.equal(walk(tree, node => node.type === 'tcp-sessions').length, 0)
      const connection = walk(tree, node => node.type === 'tcp-connection')[0]
      assert.equal(connection.props.readOnly, !canEdit)
      if (canEdit) {
        connection.props.onChange({ port: 19001 }); tree = render()
        field(tree, '연결 세션').props.onClick(); tree = render()
        assert.equal(button(tree, '저장').props.disabled, false)
        walk(tree, node => node.type === 'tcp-sessions')[0].props.onOpenConnection(); tree = render()
        assert.equal(walk(tree, node => node.type === 'tcp-connection')[0].props.tcp.port, 19001, 'draft port survives sessions round trip')
      }
      assert.equal(writes.length, writesBefore, 'menu switches never change runtime state')
      assert.equal(specWrites.length, savesBefore, 'menu switches never persist drafts')
      assert.equal(navigations.length, navigationsBefore, 'menu switches preserve URL and selected execution space')
    }
  } finally {
    modules['../auth/AuthContext'].usePermissions = permissions
    scope.scopeKey = originalScopeKey
  }
  console.log('PASS: TCP sessions have independent navigation; local/server permissions, default rule, dirty draft and selected space survive menu switches')
  detailResult = { isError: true, error: new Error('server unavailable'), refetch: () => { retries++ } }
  let tree = renderer(MockServerEditor)()
  assert.match(text(walk(tree, node => node.props?.role === 'alert')[0]), /Mock을 불러오지 못했습니다.*server unavailable/)
  assert.equal(walk(tree, node => node.props?.role === 'status').length, 0, 'a failed detail must not keep showing a loading spinner')
  button(tree, '다시 불러오기').props.onClick(); assert.equal(retries, 1)
  button(tree, '목록으로').props.onClick(); assert.equal(navigations.at(-1)[0], '/mocks?space=server%3Apublic')
  detailResult = { isError: false }
  tree = renderer(MockServerEditor)()
  assert.match(text(walk(tree, node => node.props?.role === 'status')[0]), /불러오는 중/)
  console.log('PASS: PC/server Mock editor headers display and copy the proper listener; load errors offer retry and return')

  scope.current = { origin: 'local', id: 'local', name: '내 PC' }
  detailResult = { data: { id: 'same-id', workspaceId: 'local', slug: 'same-slug', name: '같은 이름', kind: 'TCP', spec: { tcp: { port: 19000, protocolId: 'private-legacy', rules: [] }, environment: 'same' } } }
  const renderResources = renderer(MockServerEditor)
  renderResources(); tree = renderResources()
  let conn = walk(tree, node => node.type === 'tcp-connection')[0]
  assert.equal(conn.props.address, 'localhost:19000')
  assert.deepEqual(Array.from(conn.props.sources.find(source => source.id === 'secret').items, item => item.key), ['COMMON'], 'PC source does not offer server named secret overlays')
  assert.deepEqual(Array.from(conn.props.sources.find(source => source.id === 'env').items, item => item.key), ['PC'])
  walk(tree, node => node.type === 'button' && text(node).startsWith('설정'))[0].props.onClick()
  tree = renderResources()
  assert.deepEqual(walk(field(tree, 'Mock 환경 출처'), node => node.type === 'option').map(node => node.props.value), ['local', 'server'])
  field(tree, 'Mock 환경 출처').props.onChange({ target: { value: 'server' } })
  tree = renderResources()
  assert.equal(field(tree, 'Mock 적용 환경').props.value, '', 'changing source clears a same-named inherited stage')
  assert.equal(environmentQueries.at(-1).queryFn, apiFor('server', 'public').environmentsApi.list)
  field(tree, 'Mock 적용 환경').props.onChange({ target: { value: 'same' } })
  tree = renderResources()
  rejectSpec = true
  await assert.rejects(button(tree, '저장').props.onClick(), /private-legacy/)
  assert.match(text(renderResources()), /서버 공통 프로토콜이 없습니다: private-legacy/, 'missing shared protocol errors preserve the draft and exact legacy reference')
  rejectSpec = false
  await button(renderResources(), '저장').props.onClick()
  assert.equal(specWrites.at(-1).spec.resourceWorkspaceId, 'public')
  assert.equal(specWrites.at(-1).spec.envSource, 'server')
  assert.equal(specWrites.at(-1).spec.environment, 'same')
  assert.equal(specWrites.at(-1).spec.tcp.protocolId, 'private-legacy')
  assert.equal(Object.hasOwn(specWrites.at(-1).spec, 'resourceIdentity'), false)
  scope.current = { origin: 'server', id: 'public', name: '공용' }
  detailResult = { data: { ...detailResult.data, workspaceId: 'public', spec: { routes: [] }, kind: 'HTTP' } }
  const renderServer = renderer(MockServerEditor)
  renderServer(); tree = renderServer()
  button(tree, '설정').props.onClick(); tree = renderServer()
  assert.deepEqual(walk(field(tree, 'Mock 환경 출처'), node => node.type === 'option').map(node => node.props.value), ['server'], 'server Mock cannot offer a headless PC environment source')
  console.log('PASS: Mock source options use exact PC/server public variables, PC common secrets, explicit metadata and recoverable unresolved protocol errors')

  const traffic = walk(httpTree, node => typeof node.type === 'function' && node.type.name === 'TrafficPanel')[0]
  let saved = false
  const renderTraffic = renderer(() => traffic.type({ ...traffic.props, open: true, tab: 'log', journal: [{ method: 'POST', path: '/payments', query: { order: 'A B' }, headers: { host: 'old-host', 'content-type': 'application/json' }, bodyText: '{}', status: 200, matchedRuleId: 'rule', at: '2026-10-12T00:00:00Z' }], ensureSaved: async () => { requestOrder.push('save'); return saved } }))
  tree = renderTraffic()
  walk(tree, node => node.type === 'button' && walk(node, child => child.type === 'code').length > 0)[0].props.onClick()
  tree = renderTraffic()
  requests.length = 0; requestOrder.length = 0
  button(tree, '재전송').props.onClick(); await settle()
  assert.deepEqual(requestOrder, ['save'])
  assert.equal(requests.length, 0, 'replay must not send while a draft cannot be saved')
  saved = true; requestOrder.length = 0
  button(tree, '재전송').props.onClick(); await settle()
  assert.deepEqual(requestOrder, ['save', 'fetch'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, `${apiFor('server', 'public').mockBaseUrl('same-slug')}/payments?order=A%20B`)
  assert.equal(requests[0].options.headers.host, undefined)
  console.log('PASS: HTTP replay waits for saved drafts; failed saving sends nothing; successful saving precedes the request')

  const sendPanel = renderer(() => traffic.type({ ...traffic.props, open: true, tab: 'send' }))()
  const sendBox = walk(sendPanel, node => typeof node.type === 'function' && node.type.name === 'SendBox')[0]
  await testSaveGuard(ensureSaved => renderer(() => sendBox.type({ ...sendBox.props, ensureSaved })), tree => button(tree, '전송'), 'HTTP send')
  Object.assign(modules, {
    '../binding/BindingPicker': { BindingPicker: 'binding-picker' }, '../binding/TokenInput': { TokenInput: 'token-input' },
    '../lib/tokenGrammar': {}, './BigTextEditor': { BigTextEditor: 'big-text', ExpandCorner: 'expand' }, './FieldCodecButton': { FieldCodecButton: 'codec-field' },
    './icons': { DataInsertIcon: 'data-icon' }, './MockCodecEditor': { MockCodecEditor: 'codec' },
  })
  modules['../lib/mockSources'] = load('lib/mockSources.ts')
  modules['../lib/mockCodecOps'] = load('lib/mockCodecOps.ts')
  const { RouteCard } = load('components/MockRouteEditor.tsx')
  await testSaveGuard(ensureSaved => renderer(() => RouteCard({ base: apiFor('server', 'public').mockBaseUrl('same-slug'), mockId: 'same-id', spec: { routes: [] }, secrets: [], route: { id: 'route', method: 'POST', path: '/payments', rules: [] }, ensureSaved, onChange() {} })), tree => walk(tree, node => node.type === 'button' && node.props.title?.includes('예상 요청 예시값으로'))[0], 'route test')
}
async function testSaveGuard(makeRender, trigger, label) {
  let pending = deferred(), saves = 0
  const render = makeRender(() => { saves++; return pending.promise })
  requests.length = 0
  let action = trigger(render())
  action.props.onClick(); action.props.onClick()
  assert.equal(saves, 1, `${label}: rapid clicks while saving must share one operation`)
  assert.equal(trigger(render()).props.disabled, true, `${label}: saving must display the busy state`)
  assert.equal(requests.length, 0)
  pending.resolve(true); await settle(); await settle()
  assert.equal(requests.length, 1, `${label}: save completion must produce exactly one request`)
  assert.equal(trigger(render()).props.disabled, false)

  pending = deferred(); action = trigger(render())
  action.props.onClick(); action.props.onClick()
  assert.equal(saves, 2)
  pending.resolve(false); await settle(); await settle()
  assert.equal(requests.length, 1, `${label}: unsuccessful saving must block the request`)
  assert.equal(trigger(render()).props.disabled, false, `${label}: failed saving must release the busy guard`)
  pending = deferred(); trigger(render()).props.onClick()
  pending.resolve(true); await settle(); await settle()
  assert.equal(saves, 3)
  assert.equal(requests.length, 2, `${label}: retry after failed saving must work`)
  console.log(`PASS: ${label} guards rapid clicks across deferred saves and releases for retry after save failure`)
}
async function run() {
  await testAddressesAndMoves()
  await testPartialDeleteRetry()
  await testStaleSlugReplies(false)
  await testStaleSlugReplies(true)
  console.log('PASS: switching creation host ignores stale slug success and error replies')
  await testEditorHeadersAndReplay()
}
run().catch(error => { console.error(error); process.exitCode = 1 })
