import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

const BASE = 'http://127.0.0.1:5174'
const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
const choices = {
  runtime: ['desktop', 'server'], role: ['admin', 'editor', 'viewer', 'pending'], account: ['mock-dev', 'mock-other'],
  execution: ['success', 'failure', 'agent-unknown', 'inspection-error'],
  update: ['idle', 'checking', 'available', 'current', 'downloading', 'ready', 'installing', 'error'],
  mcp: ['ready', 'pending', 'error'],
}
export function createDesktopMock(factory) {
  const scenario = { runtime: 'desktop', connected: true, role: 'admin', account: 'mock-dev', execution: 'success', update: 'idle', mcp: 'ready', latencyMs: 0, errorPath: '', errorStatus: 503 }
  const resources = {}
  const remote = factory({ origin: 'server', scenario, central: resources })
  Object.assign(resources, remote.resources)
  const local = factory({ origin: 'local', scenario, central: resources })
  resources.localEnvironments = local.resources.environments
  const bindings = new Map()
  let serverUrl = BASE
  let downloadStarted = 0
  const connection = () => ({ serverUrl, mcpUrl: `${serverUrl}/mcp`, login: scenario.connected ? scenario.account : null, connected: scenario.connected })
  const update = () => {
    const elapsed = Date.now() - downloadStarted
    if (scenario.update === 'downloading' && downloadStarted && elapsed >= 2500) scenario.update = 'ready'
    return { phase: scenario.update, currentVersion: '1.0.0-mock', availableVersion: ['idle', 'current'].includes(scenario.update) ? null : '1.1.0-mock', downloadedBytes: scenario.update === 'downloading' ? Math.min(104857600, Math.round(elapsed / 2500 * 104857600)) : scenario.update === 'ready' ? 104857600 : 0, totalBytes: 104857600, message: '프론트 테스트용 상태입니다. 설치파일 다운로드·설치·앱 재시작은 수행하지 않습니다.', releaseNotes: 'Mock 데스크톱 업데이트 샘플' }
  }
  function handle(method, rawUrl, body = {}, headers = {}) {
    const url = new URL(rawUrl, BASE)
    const path = url.pathname
    if (path === '/__mock/state') {
      if (method === 'GET') return scenario
      if (method !== 'PUT') fail(405, 'GET 또는 PUT을 사용하세요.')
      for (const [key, values] of Object.entries(choices)) if (body[key] !== undefined && !values.includes(body[key])) fail(400, `${key} 값이 올바르지 않습니다.`)
      if (body.connected !== undefined && typeof body.connected !== 'boolean') fail(400, 'connected는 boolean이어야 합니다.')
      if (body.latencyMs !== undefined && (!Number.isInteger(body.latencyMs) || body.latencyMs < 0 || body.latencyMs > 5000)) fail(400, '지연은 0~5000ms 정수입니다.')
      if (body.errorPath !== undefined && (typeof body.errorPath !== 'string' || body.errorPath && !body.errorPath.startsWith('/'))) fail(400, '오류 API 경로는 /로 시작해야 합니다.')
      if (body.errorStatus !== undefined && ![400, 401, 403, 409, 500, 503].includes(body.errorStatus)) fail(400, '지원하지 않는 오류 상태입니다.')
      for (const key of Object.keys(scenario)) if (body[key] !== undefined) scenario[key] = body[key]
      downloadStarted = 0
      return scenario
    }
    if (path === '/__mock/client-response') return { paymentId: 'MOCK-PAY-001', status: 'APPROVED', body: '브라우저 요청 샘플' }
    if (path === '/__mock/form') return { __html: '<!doctype html><html lang="ko"><meta charset="utf-8"><title>Mock 결제창</title><body><h1>Mock 결제창</h1><p>폼 전송이 완료되었습니다. 실제 결제는 발생하지 않습니다.</p></body></html>' }
    const remoteRequest = path.startsWith('/api/v1/remote/') || path.startsWith('/mock/remote/') || path.startsWith('/relay/server/')
    const apiPath = path.replace(/^\/api\/v1(?:\/remote)?/, '')
    if (scenario.errorPath && (path.includes(scenario.errorPath) || apiPath.includes(scenario.errorPath))) fail(scenario.errorStatus, `Mock 오류 시나리오: ${scenario.errorPath}`)
    if (remoteRequest && !scenario.connected) fail(503, 'Mock: 회사 서버 연결이 끊겼습니다. 개인 PC 공간은 계속 사용할 수 있습니다.')
    if (remoteRequest && ((headers['x-flowlink-server'] && headers['x-flowlink-server'] !== serverUrl) || (headers['x-flowlink-account'] && headers['x-flowlink-account'] !== scenario.account))) fail(409, 'Mock: 서버 또는 로그인 계정이 변경되었습니다.')
    if (apiPath === '/auth/config') return { enabled: false, mode: 'none', mcpUrl: null, runtime: { kind: scenario.runtime === 'desktop' ? 'local' : 'server', name: '프론트 Desktop Mock', deviceId: 'mock-device' } }
    if (apiPath === '/auth/me') return { username: scenario.account, tenant: 'default', roles: scenario.role === 'admin' ? ['editor', 'admin', 'platform-admin'] : scenario.role === 'editor' ? ['editor'] : ['viewer'] }
    if (apiPath.startsWith('/desktop/')) {
      const action = apiPath.slice('/desktop/'.length)
      if (action === 'connection') {
        if (method === 'PUT') { let parsed; try { parsed = new URL(body.serverUrl) } catch { fail(400, '올바른 서버 URL이 필요합니다.') } if (!['http:', 'https:'].includes(parsed.protocol)) fail(400, 'HTTP(S) 주소가 필요합니다.'); if (serverUrl !== parsed.href.replace(/\/$/, '')) { scenario.connected = false; serverUrl = parsed.href.replace(/\/$/, '') } }
        return connection()
      }
      if (action === 'login/native') { scenario.connected = true; return { opened: true, mock: true } }
      if (action === 'logout') { scenario.connected = false; return {} }
      if (action === 'environment-bindings') {
        const scope = method === 'GET' ? Object.fromEntries(url.searchParams) : body
        const identity = `${headers['x-flowlink-server'] ?? serverUrl}:${headers['x-flowlink-account'] ?? scenario.account}`
        const key = JSON.stringify([identity, scope.origin, scope.workspaceId, scope.environment ?? null])
        const current = bindings.get(key) ?? { bindings: {}, revision: '' }
        if (method === 'PUT') { if (body.revision !== current.revision) fail(409, 'Mock 연결 설정이 변경되었습니다. 다시 불러오세요.'); if (!body.bindings || typeof body.bindings !== 'object' || Object.values(body.bindings).some(v => typeof v !== 'string')) fail(400, '환경 연결 값은 문자열이어야 합니다.'); const value = { bindings: structuredClone(body.bindings), revision: randomUUID() }; bindings.set(key, value); return value }
        return current
      }
      if (action === 'mcp' || action === 'mcp/reconcile') return { phase: scenario.mcp, message: 'IDE 연결 상태의 Mock 표시입니다. 실제 MCP 호출이나 IDE 설정 변경은 하지 않습니다.', clients: ['VS Code', 'IntelliJ IDEA'].map(label => ({ label, configured: scenario.mcp === 'ready', message: scenario.mcp === 'ready' ? 'Mock 설정 완료' : 'Mock 연결 확인 필요' })), pendingRevocations: scenario.mcp === 'pending' ? 1 : 0 }
      if (action === 'update/check') { scenario.update = 'available'; return update() }
      if (action === 'update/download') { if (scenario.update !== 'available') fail(409, '먼저 업데이트를 확인하세요.'); downloadStarted = Date.now(); scenario.update = 'downloading'; return update() }
      if (action === 'update/open-window') { if (scenario.update !== 'ready') fail(409, '다운로드 준비가 필요합니다.'); scenario.update = 'installing'; return { opened: true } }
      if (action === 'update') return update()
      fail(501, `아직 구현되지 않은 Desktop Mock API: ${action}`)
    }
    if (apiPath.startsWith('/auth/github/device/')) return apiPath.endsWith('/start') ? { sessionId: 'mock-session', userCode: 'MOCK-CODE', verificationUri: `${BASE}/__mock`, intervalSec: 1, expiresIn: 900 } : { status: 'ready', token: 'mock-token', login: scenario.account }
    if (method !== 'GET' && ['viewer', 'pending'].includes(scenario.role) && !path.startsWith('/relay/') && !['/protocols/preview', '/protocols/validate', '/mock-servers/preview', '/mock-servers/validate'].includes(apiPath)) fail(403, 'Mock: 읽기 전용 계정은 변경할 수 없습니다.')
    if (method !== 'GET' && (apiPath.startsWith('/admin/') || /\/plugins\/scripts\/[^/]+\/(approve|reject)$/.test(apiPath)) && scenario.role !== 'admin') fail(403, 'Mock: 관리자 권한이 필요합니다.')
    let host = remoteRequest || scenario.runtime === 'server' ? remote : local
    let rewritten = rawUrl
    if (path.startsWith('/relay/')) { const parts = path.split('/'); host = parts[2] === 'server' ? remote : local; parts.splice(2, 1); rewritten = parts.join('/') }
    if (path.startsWith('/mock/')) {
      if (path.startsWith('/mock/remote/')) { host = remote; rewritten = rawUrl.replace('/mock/remote/', '/mock/') }
      else if (!path.startsWith('/mock/ws/local/')) host = remote
    }
    const value = host(method, rewritten, body)
    if (apiPath === '/workspaces' && method === 'GET' && scenario.role === 'viewer') return value.map(w => ({ ...w, myRole: 'VIEWER', canManage: false }))
    if (apiPath.startsWith('/flows/') && !apiPath.endsWith('/runs') && method === 'GET' && value?.graph) return { ...value, myRole: scenario.role === 'viewer' ? 'VIEWER' : value.myRole }
    return value
  }
  return Object.assign(handle, { scenario })
}

export function installMockPresence(server, scenario) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  const rooms = new Map()
  const upgrade = (request, socket, head) => {
    const url = new URL(request.url, BASE)
    if (!['/ws/presence', '/remote/ws/presence'].includes(url.pathname)) return
    if (url.pathname.startsWith('/remote/') && !scenario.connected) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return }
    sockets.handleUpgrade(request, socket, head, ws => {
      const key = `${url.pathname}:${url.searchParams.get('flowId')}`
      const room = rooms.get(key) ?? new Map(); rooms.set(key, room)
      const peer = { id: randomUUID(), name: url.searchParams.get('name') ?? 'Mock 개발자', color: '#6b8afd', cursor: null, editing: null }
      const send = (client, data) => { if (client.readyState === 1) client.send(JSON.stringify(data)) }
      const broadcast = data => { for (const client of room.keys()) if (client !== ws) send(client, data) }
      send(ws, { t: 'hello', id: peer.id, peers: [...room.values()] }); broadcast({ t: 'join', peer }); room.set(ws, peer)
      ws.on('message', data => { let message; try { message = JSON.parse(String(data)) } catch { return } if (!['cursor', 'editing', 'saved', 'graph'].includes(message.t)) return; if (message.t === 'graph' && scenario.role === 'viewer') return; if (message.t === 'cursor') peer.cursor = { x: message.x, y: message.y }; if (message.t === 'editing') peer.editing = message.nodeId; broadcast({ ...message, id: peer.id, name: peer.name }) })
      ws.on('error', () => ws.close())
      ws.on('close', () => { room.delete(ws); broadcast({ t: 'leave', id: peer.id }); if (!room.size) rooms.delete(key) })
    })
  }
  server.httpServer?.on('upgrade', upgrade)
  server.httpServer?.once('close', () => { server.httpServer.off('upgrade', upgrade); for (const client of sockets.clients) client.terminate(); sockets.close() })
}

export const mockControlPage = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>FlowLink Mock 테스트 상태</title>
<style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 24px;background:#151820;color:#eee}label{display:block;margin:18px 0}select,input,button{font:inherit;padding:8px;margin-left:12px}a{color:#8eafff}pre{white-space:pre-wrap}</style>
<h1>데스크톱 Mock 테스트 상태</h1><p>모든 결과는 프론트 개발용 시뮬레이션입니다. 실제 설치·AI·외부 통신은 수행하지 않습니다.</p>
<form id="state"><label>실행 화면<select name="runtime"><option value="desktop">데스크톱 (PC + 서버)</option><option value="server">서버 브라우저</option></select></label>
<label>서버 연결<select name="connected"><option value="true">연결됨</option><option value="false">연결 끊김</option></select></label>
<label>권한<select name="role"><option value="admin">관리자</option><option value="editor">편집자</option><option value="viewer">읽기 전용</option><option value="pending">가입 승인 대기</option></select></label>
<label>서버 계정<select name="account"><option value="mock-dev">mock-dev</option><option value="mock-other">mock-other</option></select></label>
<label>실행 상태<select name="execution"><option value="success">정상 진행</option><option value="failure">실패</option><option value="agent-unknown">에이전트 응답 끊김 (UNKNOWN)</option><option value="inspection-error">실행 자원 검사 실패</option></select></label>
<label>앱 업데이트<select name="update">${choices.update.map(p => `<option>${p}</option>`).join('')}</select></label>
<label>IDE 연결 표시<select name="mcp">${choices.mcp.map(p => `<option>${p}</option>`).join('')}</select></label>
<label>API 지연(ms)<input name="latencyMs" type="number" min="0" max="5000" value="0"></label>
<label>오류 발생 API 경로<input name="errorPath" placeholder="예: /environments 또는 /remote/flows"></label>
<label>오류 응답<select name="errorStatus">${[400, 401, 403, 409, 500, 503].map(p => `<option${p === 503 ? ' selected' : ''}>${p}</option>`).join('')}</select></label>
<button>테스트 상태 적용</button></form><p id="message" role="status"></p><p>상태 적용 후 앱을 새로고침하면 부팅·권한 변화도 반영됩니다. 연결과 업데이트는 앱에서 주기적으로 갱신됩니다.</p>
<p><a href="/flows?space=local:local" target="_blank">내 PC 화면</a> · <a href="/flows?space=server:public" target="_blank">서버 공용 화면</a> · <a href="/flows?space=server:demo-team" target="_blank">팀 공간</a></p>
<script>const form=document.querySelector('form');fetch('/__mock/state').then(r=>r.json()).then(data=>{for(const [key,value] of Object.entries(data))if(form.elements[key])form.elements[key].value=String(value)});form.onsubmit=async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));data.connected=data.connected==='true';data.latencyMs=Number(data.latencyMs);data.errorStatus=Number(data.errorStatus);const response=await fetch('/__mock/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.querySelector('#message').textContent=response.ok?'적용했습니다. 앱 화면을 새로고침하세요.':(await response.json()).message}</script></html>`
