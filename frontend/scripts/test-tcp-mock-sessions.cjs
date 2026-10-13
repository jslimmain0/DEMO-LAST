const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const plain = value => JSON.parse(JSON.stringify(value))
function walk(node, predicate, out = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, out))
  else if (node && typeof node === 'object') { if (predicate(node)) out.push(node); walk(node.props?.children, predicate, out) }
  return out
}
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const button = (tree, label) => walk(tree, node => node.type === 'button' && node.props['aria-label'] === label)[0]
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/TcpMockSessions.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
function fixture() {
  let clock = 100000, index = 0, queryOptions, mutation, cancellation = Promise.resolve()
  const hooks = [], effects = [], toasts = [], writes = [], invalidations = [], timers = new Map()
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  const scope = { scopeKey: 'local:pc:workspace-a', current: { origin: 'local' }, loading: false, connected: true, remoteLoading: false }
  const sample = { id: 'waiting-1', remoteAddress: '127.0.0.1', remotePort: 50001, state: 'waiting', remainingMs: 30000, expiresAt: '2050-01-01T00:00:00Z', idleTimeoutMs: 30000, connectedAt: '2026-10-14T00:00:00Z', lastActivityAt: '2026-10-14T00:01:00Z', receivedMessages: 20 }
  const query = { data: [sample, { ...sample, id: 'processing-2', remoteAddress: '::1', state: 'processing', remainingMs: null, expiresAt: null }], dataUpdatedAt: clock, isPending: false, isFetching: false, isError: false, refetch() { invalidations.push('refresh') } }
  const reply = deferred()
  const qc = {
    cancelQueries: () => cancellation,
    getQueryState: () => query,
    setQueryData: (key, update) => { writes.push(plain(key)); query.data = update(query.data); query.dataUpdatedAt = clock },
    invalidateQueries: options => { invalidations.push(plain(options.queryKey)); return Promise.resolve() },
  }
  const jsx = (type, props) => ({ type, props })
  const react = {
    useRef: initial => { const i = index++; return hooks[i] ??= { current: initial } },
    useState: initial => { const i = index++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value }] },
    useEffect: effect => { const i = index++; if (!(i in hooks)) { hooks[i] = true; effects.push(effect()) } },
  }
  const exported = {}
  vm.runInNewContext(code, {
    exports: exported, Date: class extends Date { static now() { return clock } }, document,
    window: { setInterval: callback => { timers.set(timers.size + 1, callback); return timers.size }, clearInterval: id => timers.delete(id) },
    require: name => ({
      react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../app/WorkspaceContext': { useWorkspace: () => scope, useApi: () => ({ mocksApi: { tcpSessions: () => query.data, extendTcpSession: (mockId, id, ms) => { writes.push({ mockId, id, ms }); return reply.promise } } }) },
      '@tanstack/react-query': { useQuery: options => { queryOptions = options; return query }, useMutation: options => { mutation = options; return { isPending: false, mutate: id => mutation.mutationFn(id) } }, useQueryClient: () => qc },
      '../design/ui': { ui: { mini: {} } }, '../lib/apiError': { apiErrorMessage: error => error.message }, './toast': { toast: message => toasts.push(message) },
    })[name] ?? {},
  })
  return {
    ...exported, query, scope, toasts, writes, invalidations, reply,
    render: (readOnly = false, onOpenConnection) => { index = 0; return exported.TcpMockSessions({ mockId: 'same-mock-id', readOnly, onOpenConnection }) },
    get options() { return queryOptions }, get mutation() { return mutation },
    tick: ms => { clock += ms; timers.forEach(callback => callback()) },
    pauseCancellation: () => { const pause = deferred(); cancellation = pause.promise; return pause },
    unmount: () => effects.forEach(cleanup => cleanup?.()),
  }
}

test('TCP Mock 세션: 서버 남은시간 기준 카운트다운, 대기/처리 상태, 권한과 조회 실패를 구분한다', () => {
  const f = fixture()
  let tree = f.render()
  assert.deepEqual(plain(f.options.queryKey), ['mock-tcp-sessions', 'local:pc:workspace-a', 'same-mock-id'])
  assert.equal(f.options.refetchInterval, 2500)
  assert.equal(f.options.refetchIntervalInBackground, false)
  assert.match(text(tree), /30초 남음/)
  assert.match(text(tree), /기본 유휴 30초/)
  assert.match(text(tree), /다음 요청을 기다릴 때 연장할 수 있습니다/)
  assert.match(text(tree), /\[::1\]:50001/)
  assert.equal(button(tree, '세션 waiting-1 1분 연장').props.disabled, false)
  assert.equal(button(tree, '세션 processing-2 1분 연장').props.disabled, true)
  f.tick(11000); tree = f.render()
  assert.match(text(tree), /19초 남음/)
  f.tick(-20000)
  assert.match(text(f.render()), /30초 남음/, 'client clock drift cannot add time')
  assert.equal(button(f.render(true), '세션 waiting-1 1분 연장').props.disabled, true)
  assert.match(text(f.render(true)), /편집 권한이 필요합니다/)
  f.query.data[0].remainingMs = 3600000
  assert.equal(button(f.render(), '세션 waiting-1 1분 연장').props.disabled, true)
  assert.match(text(f.render()), /1분을 추가하려면 잠시 기다리세요/)
  f.query.isError = true; f.query.error = new Error('접속 실패'); tree = f.render()
  assert.match(text(tree), /세션을 불러오지 못했습니다.*접속 실패/)
  assert.doesNotMatch(text(tree), /현재 연결된 세션이 없습니다/)
  assert.equal(button(tree, '세션 waiting-1 1분 연장'), undefined)
  f.query.isError = false; f.query.data = []; tree = f.render()
  assert.match(text(tree), /현재 연결된 세션이 없습니다/)
  f.scope.loading = true; assert.match(text(f.render()), /실행 위치를 확인하는 중/)
  assert.equal(f.options.enabled, false)
  f.unmount()
})

test('TCP Mock 세션: 독립 화면에서 연결 설정으로 이동하는 액션은 조회·연장 요청을 만들지 않는다', () => {
  const f = fixture(); let opened = 0
  const tree = f.render(true, () => { opened++ })
  const action = walk(tree, node => node.type === 'button' && text(node) === '연결 설정 보기')[0]
  assert.equal(action.props.disabled, undefined, 'viewers can inspect connection settings')
  action.props.onClick()
  assert.equal(opened, 1)
  assert.equal(f.writes.length, 0)
  assert.equal(f.invalidations.length, 0)
  f.unmount()
})

test('TCP Mock 세션: 연장 응답 뒤에만 카운트다운·토스트 갱신, 다른 행 기한을 늘리지 않는다', async () => {
  const f = fixture(); f.render()
  f.query.data.push({ ...f.query.data[0], id: 'waiting-other', remainingMs: 40000 })
  const pending = f.mutation.mutationFn('waiting-1')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.writes, [{ mockId: 'same-mock-id', id: 'waiting-1', ms: 60000 }])
  assert.equal(f.toasts.length, 0)
  f.tick(5000)
  assert.equal(f.options.refetchInterval, 2500)
  f.render(); assert.equal(f.options.refetchInterval, false)
  const updated = { ...f.query.data[0], remainingMs: 85000 }
  f.reply.resolve(updated); const result = await pending
  f.mutation.onSuccess(result)
  assert.equal(f.query.data[0].remainingMs, 85000)
  assert.equal(f.query.data[2].remainingMs, 35000)
  assert.match(f.toasts[0], /1분 연장/)
  assert.match(text(f.render()), /1분 25초 남음/)
  f.mutation.onSettled()
  assert.deepEqual(f.invalidations[0], ['mock-tcp-sessions', 'local:pc:workspace-a', 'same-mock-id'])
  f.unmount()
})

test('TCP Mock 세션: Mock 전환 중 대기하던 연장은 전송하지 않고, 종료/권한 실패는 보존한다', async () => {
  const f = fixture(); f.render()
  const pause = f.pauseCancellation()
  const pending = f.mutation.mutationFn('waiting-1')
  f.unmount(); pause.resolve()
  await assert.rejects(pending, /Mock이 변경/)
  assert.equal(f.writes.length, 0)
  f.mutation.onError(new Error('연결 종료')); f.mutation.onSettled()
  assert.equal(f.toasts.length, 0)
  assert.equal(f.invalidations.length, 0)
  const g = fixture(); g.render(true)
  await assert.rejects(g.mutation.mutationFn('waiting-1'), /대기 중인 연결만/)
  assert.equal(g.writes.length, 0)
  g.render(); g.mutation.onError(new Error('상대 앱이 연결을 종료했습니다.')); g.mutation.onSettled()
  assert.match(text(g.render()), /상대 앱이 연결을 종료했습니다/)
  assert.equal(g.invalidations.length, 1)
  g.unmount()
})

test('TCP Mock 세션: 프론트 mock fixture도 로컬/서버 격리, 연장 상한·처리중 실패·중지 후 제거를 지킨다', async () => {
  const { createMockApi } = await import('../dev/mock-api.mjs')
  const { createDesktopMock } = await import('../dev/mock-desktop.mjs')
  const api = createDesktopMock(createMockApi)
  const local = '/api/v1/mock-servers/demo-tcp-mock', remote = '/api/v1/remote/mock-servers/demo-tcp-mock'
  api('PATCH', local, { enabled: true }); api('PATCH', remote, { enabled: true })
  const pc = api('GET', `${local}/tcp-sessions`), server = api('GET', `${remote}/tcp-sessions`)
  assert.notEqual(pc[0].id, server[0].id)
  const extended = api('POST', `${local}/tcp-sessions/${pc[0].id}/extend`, { extendMs: 60000 })
  assert.ok(extended.remainingMs >= pc[0].remainingMs + 59950)
  assert.ok(api('GET', `${remote}/tcp-sessions`)[0].remainingMs <= server[0].remainingMs)
  assert.throws(() => api('POST', `${local}/tcp-sessions/${pc[0].id}/extend`, { extendMs: 3600000 }), { status: 400 })
  assert.throws(() => api('POST', `${local}/tcp-sessions/${pc[1].id}/extend`, { extendMs: 60000 }), { status: 400 })
  assert.throws(() => api('POST', `${local}/tcp-sessions/${server[0].id}/extend`, { extendMs: 60000 }), { status: 404 })
  api('PATCH', local, { enabled: false })
  assert.deepEqual(api('GET', `${local}/tcp-sessions`), [])
  assert.throws(() => api('POST', `${local}/tcp-sessions/${pc[0].id}/extend`, { extendMs: 60000 }), { status: 404 })
})
