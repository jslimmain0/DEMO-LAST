import { randomUUID } from 'node:crypto'
import { createMockFeatures } from './mock-features.mjs'
import { createDesktopMock, mockControlPage, installMockPresence } from './mock-desktop.mjs'

const now = () => new Date().toISOString()
const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
const unsupported = () => fail(501, '프론트 mock 모드에서는 이 기능을 지원하지 않습니다. 실제 실행·AI·외부 연결은 백엔드 모드에서 확인하세요.')

// shortcut: UI 개발용 메모리 데이터다, 실제 DB·실행 정확도 검증은 백엔드 통합 테스트를 사용한다.
export function createMockApi({ origin = 'server', scenario = {}, central } = {}) {
  const timestamp = now()
  const workspaces = [{ id: 'public', name: '공용 (프론트 Mock)', kind: 'PUBLIC', myRole: 'OWNER', canManage: true }]
  const graph = {
    nodes: [
      { id: 'start', type: 'start', name: '시작', x: 80, y: 160 },
      { id: 'input', type: 'set', name: '주문 정보', x: 340, y: 160, vars: [{ id: 'order', key: 'orderId', value: 'ORDER-2026-001' }, { id: 'amount', key: 'amount', value: '15000' }] },
      { id: 'request', type: 'http', name: '결제 요청', x: 600, y: 160, method: 'POST', baseUrl: 'https://example.test', path: '/payments', bodyType: 'json', respType: 'json', reqMode: 'server', fields: { params: [], headers: [], body: [{ id: 'amount', key: 'amount', value: '15000', type: 'number' }] }, outputs: [{ key: 'paymentId' }, { key: 'status' }] },
      { id: 'end', type: 'end', name: '완료', x: 860, y: 160 },
      { id: 'note', type: 'note', name: '안내', noteText: '프론트 개발용 샘플입니다. 실제 요청은 전송되지 않습니다.', x: 340, y: 400 },
    ],
    edges: [{ id: 'e1', from: 'start', to: 'input' }, { id: 'e2', from: 'input', to: 'request' }, { id: 'e3', from: 'request', to: 'end' }],
  }
  const flows = [{ id: 'demo-flow', name: '결제 API 샘플', description: '캔버스·속성·버전 저장을 확인하는 프론트 개발용 흐름', workspaceId: 'public', folderId: 'demo-folder', myRole: 'OWNER', currentVersion: 1, createdAt: timestamp, updatedAt: timestamp, graph }]
  const folders = [{ id: 'demo-folder', name: '샘플 워크플로', parentId: null, workspaceId: 'public', createdAt: timestamp }]
  const mocks = [{ id: 'demo-mock', name: '결제 응답 샘플', slug: 'payments', kind: 'HTTP', enabled: false, workspaceId: 'public', currentVersion: 1, createdAt: timestamp, updatedAt: timestamp, spec: { routes: [{ id: 'payment-route', method: 'POST', path: '/payments', rules: [{ id: 'payment-rule', when: [], status: 200, contentType: 'json', body: '{"paymentId":"PAY-001","status":"APPROVED"}' }] }] } }]
  const protocols = [{ id: 'demo-protocol', name: '주문 전문 샘플', workspaceId: 'public', createdAt: timestamp, updatedAt: timestamp, spec: { encoding: 'UTF-8', lengthField: '', lengthFormat: 'ascii-decimal', includesSelf: false, discriminator: '', header: [], messages: ['request', 'response'].map(key => ({ key, label: key === 'request' ? '주문 요청' : '주문 응답', fields: [{ name: 'orderId', len: 20, type: 'string' }, { name: 'amount', len: 10, type: 'numeric', pad: 'left/zero' }] })) } }]
  const environments = [{ name: '개발', vars: { API_BASE_URL: 'https://example.test', ORDER_ID: 'ORDER-2026-001' }, workspaceId: 'public', updatedAt: timestamp }]
  const secrets = []
  const plugins = []
  const executions = ['SUCCEEDED', 'FAILED'].map((status, index) => ({
    id: `demo-execution-${index}`, flowId: 'demo-flow', flowName: flows[0].name, workspaceId: 'public', flowVersionId: 'demo-flow-v1', status, trigger: 'MANUAL', triggeredBy: 'mock-dev', startedAt: timestamp, finishedAt: timestamp,
    error: index ? '샘플 오류: 결제 API 응답 시간 초과' : null,
    nodes: graph.nodes.filter(n => !['note', 'group'].includes(n.type)).map((n, seq) => ({ id: `result-${index}-${n.id}`, nodeId: n.id, nodeName: n.name, nodeType: n.type, seq, status: index && n.type === 'http' ? 'FAILED' : 'SUCCEEDED', ok: !(index && n.type === 'http'), durationMs: 120, httpStatus: n.type === 'http' ? (index ? 504 : 200) : null, outputJson: JSON.stringify(n.type === 'http' ? { paymentId: 'PAY-001', status: 'APPROVED' } : {}), responseText: n.type === 'http' ? '프론트 개발용 샘플 응답' : null })),
  }))
  const versions = new Map()
  const inputs = new Map()
  const settings = new Map()
  const members = new Map([['public', [{ username: 'mock-dev', role: 'OWNER' }]]])
  const interactive = {
    nodes: [
      { id: 'begin', type: 'start', name: '시작', x: 40, y: 120 },
      { id: 'user', type: 'input', name: '사용자 입력', x: 280, y: 120, waitMsg: 'Mock 주문 정보를 입력하세요.', waitFields: [{ key: 'orderId', label: '주문 번호', type: 'string' }] },
      { id: 'browser', type: 'http', name: '브라우저 요청', reqMode: 'client', method: 'GET', baseUrl: 'http://127.0.0.1:5174', path: '/__mock/client-response', respType: 'json', x: 520, y: 120 },
      { id: 'popup', type: 'form', name: 'Mock 결제창', formAction: 'http://127.0.0.1:5174/__mock/form', formDisplay: 'iframe', formMethod: 'POST', x: 760, y: 120 },
      { id: 'callback', type: 'wait', name: '콜백 대기', waitTimeoutSec: 120, x: 1000, y: 120 },
      { id: 'finish', type: 'end', name: '완료', x: 1240, y: 120 },
    ],
    edges: ['begin', 'user', 'browser', 'popup', 'callback'].map((from, i) => ({ id: `interactive-${i}`, from, to: ['user', 'browser', 'popup', 'callback', 'finish'][i] })),
  }
  flows.push({ ...structuredClone(flows[0]), id: 'demo-interactive', name: '입력·브라우저·결제창·콜백 테스트', description: '입력 모달 → 브라우저 요청 → iframe → 콜백 대기. 실행 결과의 테스트 콜백으로 재개하세요.', graph: interactive })
  mocks.push({ ...structuredClone(mocks[0]), id: 'demo-tcp-mock', name: 'TCP 전문 샘플', slug: 'tcp-orders', kind: 'TCP', spec: { tcp: { port: 19000, protocolId: 'demo-protocol', timeoutMs: 3000, rules: [{ id: 'tcp-rule', when: [], then: { mode: 'mock', fields: { orderId: 'MOCK-001', amount: '15000' } } }] } } })
  if (origin === 'local') {
    workspaces.splice(0, 1, { id: 'local', name: '내 PC (Mock)', kind: 'PERSONAL', myRole: 'OWNER', canManage: true })
    for (const list of [flows, folders, mocks, protocols, environments, executions]) for (const item of list) item.workspaceId = 'local'
    flows[0].name = '내 PC 결제 샘플'
  } else workspaces.push({ id: 'demo-team', name: '개발 팀 (Mock)', kind: 'TEAM', myRole: 'OWNER', canManage: true })
  const version = (item, value, body = {}) => ({ id: randomUUID(), versionNo: item.currentVersion, name: item.name, note: body.note ?? '프론트 Mock 샘플', pinned: body.pinned ?? false, createdBy: 'mock-dev', createdAt: now(), value: structuredClone(value) })
  for (const item of [...flows, ...mocks]) versions.set(item.id, [version(item, item.graph ?? item.spec)])
  const mockSummary = item => ({ ...item, routeCount: item.spec.routes?.length ?? 0, routeLabels: (item.spec.routes ?? []).map(r => `${r.method} ${r.path}`), tcpRuleCount: item.spec.tcp?.rules?.length ?? 0, tcpPort: item.spec.tcp?.port ?? null, protocolName: (central?.protocols ?? protocols).find(p => p.id === item.spec.tcp?.protocolId)?.name ?? null, hasCodec: !!item.spec.codec, requestCount: 0, recentRequests: 0, unmatchedRequests: 0 })
  const resources = { protocols, plugins, environments, secrets }
  const features = createMockFeatures({ origin, scenario, flows, folders, mocks, protocols: central?.protocols ?? protocols, plugins, executions, workspaces, environments, central, secrets, versions, members, version, mockSummary, fail })

  const handle = function (method, rawUrl, body = {}) {
    const url = new URL(rawUrl, 'http://mock.local')
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/v1(?:\/remote)?/, ''))
    const parts = path.split('/').filter(Boolean)
    const [resource, id, action, no, operation] = parts
    const workspaceId = url.searchParams.get('workspaceId') ?? (origin === 'local' ? 'local' : 'public')
    const scoped = list => list.filter(item => item.workspaceId === workspaceId)
    const found = list => list.find(item => item.id === id && item.workspaceId === workspaceId) ?? fail(404, 'Mock 데이터를 찾을 수 없습니다.')
    const extra = features(method, url, body, workspaceId)
    if (extra !== undefined) return extra

    if (method === 'GET' && path === '/auth/config') return { enabled: false, mode: 'none', mcpUrl: null, runtime: { kind: 'server', name: '프론트 Mock' } }
    if (method === 'GET' && path === '/auth/me') return { username: 'mock-dev', tenant: 'default', roles: ['editor', 'admin', 'platform-admin'] }
    if (method === 'GET' && path === '/distribution') return { serverUrl: 'http://127.0.0.1:5174', mcpUrl: '', serverVersion: '프론트 Mock', automaticUpdateAllowed: false, version: null, available: false, releaseStatus: 'MISSING', releaseMessage: '프론트 Mock 모드 · 설치파일 다운로드는 실제 서버에서 확인하세요.', release: null, installerUrl: null }
    if (method === 'GET' && path === '/admin/me') return { username: 'mock-dev', admin: true, authenticated: true, pendingCount: 0, pendingPlugins: 0, myStatus: 'APPROVED' }
    if (method === 'GET' && path === '/admin/users') return [{ username: 'mock-dev', globalRole: 'ADMIN', status: 'APPROVED', lastSeenAt: timestamp, createdAt: timestamp }]
    if (method === 'GET' && path === '/admin/workspaces') return { publicFlowCount: flows.filter(f => f.workspaceId === 'public').length, publicMockCount: mocks.filter(m => m.workspaceId === 'public').length, workspaces: workspaces.filter(w => w.id !== 'public').map(w => ({ ...w, flowCount: flows.filter(f => f.workspaceId === w.id).length, mockCount: mocks.filter(m => m.workspaceId === w.id).length, members: members.get(w.id) ?? [], createdAt: timestamp })) }
    if (resource === 'workspaces') {
      if (!id && method === 'GET') return workspaces
      if (!id && method === 'POST') { const item = { id: randomUUID(), name: body.name, kind: 'TEAM', myRole: 'OWNER', canManage: true }; workspaces.push(item); members.set(item.id, [{ username: 'mock-dev', role: 'OWNER' }]); return item }
      if (action === 'members') {
        if (!workspaces.some(w => w.id === id)) fail(404, '공간이 없습니다.')
        const list = members.get(id) ?? []
        if (method === 'GET') return list
        if (method === 'PUT') { const item = list.find(m => m.username === body.username); if (item) item.role = body.role; else list.push(body); members.set(id, list); return list }
        if (method === 'DELETE') { members.set(id, list.filter(m => m.username !== no)); return members.get(id) }
      }
      return unsupported()
    }
    if (resource === 'settings' && ['relay', 'notify'].includes(id)) {
      if (method === 'PUT') settings.set(`${workspaceId}:${id}`, body.value)
      if (['GET', 'PUT'].includes(method)) return { value: settings.get(`${workspaceId}:${id}`) ?? null, effective: 'http://127.0.0.1:5174', auto: null }
    }
    if (resource === 'assistant' && method === 'GET') {
      if (id === 'config') return { available: false, usingRealLlm: false, model: 'mock', authMode: 'stub' }
      if (id === 'skills') return { instructions: '', user: [] }
      if (id === 'sessions') return []
      if (id === 'oauth' && action === 'status') return { connected: false, pending: false, error: null }
      if (id === 'oauth' && action === 'models') return { models: [], current: 'mock' }
      if (id === 'oauth' && action === 'info') return { connected: false, login: null, avatarUrl: null, plan: null, sku: null, chatEnabled: false, agentEnabled: false, quotas: [], currentModel: 'mock', tokenExpiresAt: null }
    }
    if (method === 'GET' && ['/transforms', '/codecs', '/plugins/api'].includes(path)) return []
    if (resource === 'executions' && method === 'GET') {
      if (id) return found(executions)
      const list = scoped(executions).filter(e => (!url.searchParams.get('status') || e.status === url.searchParams.get('status')) && (!url.searchParams.get('flowId') || e.flowId === url.searchParams.get('flowId')) && (!url.searchParams.get('from') || Date.parse(e.startedAt) >= Number(url.searchParams.get('from'))) && (!url.searchParams.get('to') || Date.parse(e.startedAt) <= Number(url.searchParams.get('to'))))
      const offset = Number(url.searchParams.get('offset') ?? 0)
      return list.slice(offset, offset + Number(url.searchParams.get('limit') ?? 50))
    }
    if (resource === 'mock-servers' && method === 'GET' && id === 'fleet') return { workspaces: workspaces.map(w => ({ ...w, mine: true })), servers: mocks.map(m => ({ ...mockSummary(m), readable: true, myRole: 'OWNER', listening: false, usedBy: [] })), ports: [], httpPort: 5174, contextPath: '', generatedAt: now() }
    if (resource === 'mock-servers' && method === 'GET' && id === 'usages') return {}
    if (resource === 'mock-servers' && method === 'GET' && id === 'slug-check') return { slug: url.searchParams.get('slug'), available: !scoped(mocks).some(m => m.slug === url.searchParams.get('slug')) }

    if (resource === 'environments' || resource === 'secrets') {
      const list = resource === 'environments' ? environments : secrets
      if (!id && method === 'GET') return scoped(list)
      const environment = body.environment ?? url.searchParams.get('environment') ?? null
      const index = list.findIndex(e => e.name === id && e.workspaceId === workspaceId && (resource !== 'secrets' || e.environment === environment))
      if (id && method === 'PUT') {
        const item = { name: id, workspaceId, updatedAt: now(), ...(resource === 'environments' ? { vars: body.vars } : { environment, createdAt: now() }) }
        if (index < 0) list.push(item); else list[index] = item
        return item
      }
      if (id && method === 'DELETE') { if (index < 0) fail(404, '항목이 없습니다.'); list.splice(index, 1); return {} }
      if (resource === 'environments' && action === 'rename' && method === 'POST') { if (index < 0) fail(404, '환경이 없습니다.'); if (scoped(list).some(e => e.name === body.to)) fail(409, '환경 이름이 중복됩니다.'); list[index].name = body.to; return list[index] }
    }
    const collections = { flows, folders, 'mock-servers': mocks, protocols, plugins }
    const list = collections[resource]
    const itemId = resource === 'plugins' ? action : id
    if (resource === 'plugins' && id !== 'scripts') return unsupported()
    const subAction = resource === 'plugins' ? no : action
    if (list) {
      if (['preview', 'try'].includes(itemId)) return unsupported()
      if (!itemId && method === 'GET') return scoped(list).map(item => resource === 'flows' ? { ...item, nodeCount: item.graph.nodes.length, nodeTypes: item.graph.nodes.map(n => n.type), nodeCats: item.graph.nodes.map(n => n.cat ?? n.type) } : resource === 'folders' ? { ...item, flowCount: flows.filter(f => f.folderId === item.id).length } : resource === 'mock-servers' ? mockSummary(item) : resource === 'protocols' ? { ...item, encoding: item.spec.encoding, messageCount: item.spec.messages.length } : item)
      if ((!itemId || resource === 'flows' && id === 'import') && method === 'POST') {
        if (resource === 'flows' && id === 'import' && (!Array.isArray(body.nodes) || !Array.isArray(body.edges))) fail(400, 'nodes와 edges 배열이 필요합니다.')
        const item = { id: randomUUID(), name: body.name ?? '새 워크플로', workspaceId: body.workspaceId ?? workspaceId, createdAt: now(), updatedAt: now(), currentVersion: 1, myRole: 'OWNER' }
        if (resource === 'flows') Object.assign(item, { description: body.description ?? '', folderId: body.folderId ?? null, graph: id === 'import' ? body : { nodes: [{ id: randomUUID(), type: 'start', name: '시작', x: 100, y: 160 }, { id: randomUUID(), type: 'end', name: '완료', x: 500, y: 160 }], edges: [] } })
        if (resource === 'folders') item.parentId = body.parentId ?? null
        if (resource === 'mock-servers') { if (scoped(mocks).some(m => m.slug === body.slug)) fail(409, 'slug가 중복됩니다.'); Object.assign(item, { slug: body.slug, kind: body.type ?? 'HTTP', enabled: false, spec: { routes: [] } }) }
        if (resource === 'protocols') item.spec = body.spec
        if (resource === 'plugins') Object.assign(item, { pluginId: body.source?.match(/\bid\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? `mock-${item.id}`, kind: body.source?.match(/\bkind\s*:\s*['"](fieldCodec|messageCodec)['"]/)?.[1] ?? 'transform', source: body.source, status: 'DRAFT', createdBy: 'mock-dev', live: false, dirty: false, usages: 0, meta: null, liveSource: null, sampleJson: null, submittedBy: null, submittedAt: null, reviewNote: null, reviewedBy: null, reviewedAt: null })
        list.push(item)
        if (item.graph || resource === 'mock-servers') versions.set(item.id, [version(item, item.graph ?? item.spec)])
        return item
      }
      const item = list.find(i => i.id === itemId && i.workspaceId === workspaceId)
      if (!item) fail(404, 'Mock 데이터를 찾을 수 없습니다.')
      if (!subAction && method === 'GET') return resource === 'mock-servers' ? mockSummary(item) : item
      if (!subAction && method === 'DELETE') {
        if (resource === 'folders') { flows.filter(f => f.folderId === item.id).forEach(f => { f.folderId = null }); folders.filter(f => f.parentId === item.id).forEach(f => { f.parentId = item.parentId }) }
        list.splice(list.indexOf(item), 1); versions.delete(item.id); return {}
      }
      if (resource === 'mock-servers' && subAction === 'state' && method === 'GET') return { state: {}, seq: 0, hits: {}, requestCount: 0 }
      if (resource === 'mock-servers' && ['requests', 'tcp-log'].includes(subAction) && ['GET', 'DELETE'].includes(method)) return []
      if (resource === 'flows' && subAction === 'triggers' && method === 'GET') return []
      if (resource === 'flows' && subAction === 'runs' && method === 'GET') return scoped(executions).filter(e => e.flowId === item.id).slice(0, Number(url.searchParams.get('limit') ?? 50))
      if (resource === 'flows' && subAction === 'run-input' && ['GET', 'PUT'].includes(method)) { if (method === 'PUT') inputs.set(item.id, body.vars); return { vars: inputs.get(item.id) ?? {} } }
      if (['flows', 'mock-servers'].includes(resource) && subAction === 'versions') {
        const history = versions.get(item.id)
        if (!no && method === 'GET') return history.map(({ value: _value, ...summary }) => summary)
        const v = history.find(v => v.versionNo === Number(no))
        if (no && !v) fail(404, '버전이 없습니다.')
        if (no && !operation && method === 'GET') return v.value
        if (operation === 'pin' && method === 'PUT') { v.pinned = !!body.pinned; const { value: _value, ...summary } = v; return summary }
        if ((!no || operation === 'restore') && method === 'POST') {
          const value = no ? v.value : body.graph
          if (resource === 'flows' && (!Array.isArray(value?.nodes) || !Array.isArray(value?.edges))) fail(400, 'nodes와 edges 배열이 필요합니다.')
          item.currentVersion++; item.updatedAt = now(); item[resource === 'flows' ? 'graph' : 'spec'] = structuredClone(value)
          const saved = version(item, value, body); history.unshift(saved); const { value: _value, ...summary } = saved; return summary
        }
      }
      if (resource === 'mock-servers' && subAction === 'spec' && method === 'PUT') { item.spec = structuredClone(body.spec); item.currentVersion++; item.updatedAt = now(); versions.get(item.id).unshift(version(item, item.spec, body)); return mockSummary(item) }
      if (resource === 'flows' && subAction === 'folder' && method === 'PUT') { item.folderId = body.folderId; return {} }
      if (resource === 'folders' && subAction === 'parent' && method === 'PUT') {
        let parent = body.parentId
        const seen = new Set([item.id])
        while (parent) { if (seen.has(parent)) fail(400, '자기 자신이나 하위 폴더로 이동할 수 없습니다.'); seen.add(parent); const folder = scoped(folders).find(f => f.id === parent); if (!folder) fail(404, '상위 폴더가 없습니다.'); parent = folder.parentId }
        item.parentId = body.parentId; return item
      }
      if (!subAction && ['PUT', 'PATCH'].includes(method)) {
        for (const key of ['name', 'description', 'spec', 'source', 'workspaceId', 'enabled']) if (body[key] !== undefined) item[key] = structuredClone(body[key])
        item.updatedAt = now(); return resource === 'mock-servers' ? mockSummary(item) : item
      }
    }
    return unsupported()
  }
  return Object.assign(handle, { resources })
}

export function mockApiPlugin() {
  const handle = createDesktopMock(createMockApi)
  return {
    name: 'flowlink-dev-mock',
    apply: 'serve',
    configureServer(server) {
      installMockPresence(server, handle.scenario)
      server.middlewares.use(async (req, res, next) => {
        if (req.url === '/__mock') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(mockControlPage); return }
        if (!/^\/(?:api(?:\/|$)|mock\/|relay\/|__mock\/|desktop\/)/.test(req.url ?? '')) return next()
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        try {
          let text = ''
          for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 2 * 1024 * 1024) fail(413, 'Mock 요청이 너무 큽니다.') }
          let body = {}
          if (text) { if (req.headers?.['content-type']?.includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(text)); else { try { body = JSON.parse(text) } catch { if (req.url.startsWith('/api/') || req.url.startsWith('/__mock/')) fail(400, 'JSON 요청 본문이 올바르지 않습니다.'); body = { body: text } } } }
          if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'JSON 객체가 필요합니다.')
          if (handle.scenario.latencyMs) await new Promise(resolve => setTimeout(resolve, handle.scenario.latencyMs))
          const data = handle(req.method, req.url, body, req.headers ?? {})
          if (data?.__html !== undefined) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(data.__html) }
          else { res.statusCode = data?.__status ?? 200; res.end(JSON.stringify(data?.__body ?? data)) }
        } catch (error) {
          res.statusCode = error.status ?? 500
          res.end(JSON.stringify({ message: error.message, status: res.statusCode }))
        }
      })
    },
  }
}
