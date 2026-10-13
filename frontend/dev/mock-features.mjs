import { randomUUID } from 'node:crypto'

const now = () => new Date().toISOString()
export function createMockFeatures(state) {
  const { origin, scenario, flows, folders, mocks, protocols, plugins, executions, workspaces, environments, central, versions, members, version, mockSummary, fail } = state
  const sessions = []
  const triggers = []
  const running = new Map()
  const logs = new Map()
  const tcpSessions = new Map()
  let skills = { instructions: '프론트 테스트용 AI 응답입니다.', user: [] }
  let oauth = false
  let model = 'mock-model'
  const meta = { id: 'mock-transform', label: 'Mock 변환', description: 'UI 테스트용 고정 응답', kind: 'transform', inputs: [{ key: 'input', label: '입력', type: 'string' }], outputs: [{ key: 'result', label: '결과', type: 'string' }], params: [] }
  const users = [{ username: 'mock-dev', globalRole: 'ADMIN', status: 'APPROVED', lastSeenAt: now(), createdAt: now() }, { username: 'waiting-user', globalRole: 'MEMBER', status: 'PENDING', lastSeenAt: now(), createdAt: now() }]
  const scoped = (list, workspaceId) => list.filter(i => i.workspaceId === workspaceId)
  const find = (list, id, workspaceId) => scoped(list, workspaceId).find(i => i.id === id) ?? fail(404, 'Mock 데이터가 없습니다.')
  const availableEnvironments = source => source === origin ? environments : source === 'server' ? central?.environments ?? [] : central?.localEnvironments ?? []
  const environmentIssue = (name, source) => name && !availableEnvironments(source).some(e => e.name === name) ? `선택한 ${source === 'local' ? '내 PC' : '서버'} 환경이 없습니다: ${name}` : null
  const summary = p => ({ ...p, dirty: !!p.live && p.source !== p.liveSource, meta: { ...meta, id: p.pluginId, label: p.name } })
  if (origin === 'server') {
    plugins.push({ id: 'demo-plugin', workspaceId: 'public', name: 'Mock 변환', pluginId: 'mock-transform', kind: 'transform', status: 'APPROVED', source: "({ id: 'mock-transform', label: 'Mock 변환', inputs: [{key:'input'}], outputs: [{key:'result'}], apply(inputs) { return {result: inputs.input} } })", liveSource: '', sampleJson: '{"input":"샘플"}', live: true, dirty: false, usages: 0, createdBy: 'mock-dev', submittedBy: 'mock-dev', submittedAt: now(), updatedAt: now(), reviewNote: null, reviewedBy: 'mock-dev', reviewedAt: now(), meta })
    plugins.at(-1).liveSource = plugins.at(-1).source
  }

  // shortcut: 네트워크·SpEL·플러그인 계산은 재현하지 않고 UI 상태를 만든다, 실제 실행 정확도는 백엔드 통합 테스트로 검증한다.
  const result = (node, seq, output = { result: 'Mock 샘플 결과' }) => ({ id: randomUUID(), nodeId: node.id, nodeName: node.name, nodeType: node.type, seq, status: 'SUCCEEDED', ok: true, executionAgent: node.type === 'transform' ? 'server' : node.executionAgent ?? origin, durationMs: 120, httpStatus: node.type === 'http' ? 200 : null, output, outputJson: JSON.stringify(output), requestText: '프론트 Mock 요청', responseText: JSON.stringify(output) })
  function advance(execution, resume) {
    const run = running.get(execution.id)
    if (!run || !['RUNNING', 'WAITING'].includes(execution.status)) return execution
    if (resume) {
      if (resume.nodeId && resume.nodeId !== run.nodes[run.index]?.id) fail(409, '대기 중인 노드가 아닙니다.')
      if (resume.aborted || resume.error) { execution.status = resume.aborted ? 'CANCELLED' : 'FAILED'; execution.error = resume.error ?? 'Mock 실행 중단'; execution.finishedAt = now(); execution.nodes.push({ ...result(run.nodes[run.index], run.index), status: resume.aborted ? 'SKIPPED' : 'FAILED', ok: false }); clearPending(execution); return execution }
      execution.nodes.push(result(run.nodes[run.index], run.index, resume.formValues ?? resume.callback ?? { body: resume.body ?? 'Mock 재개 결과' }))
      run.index++; clearPending(execution); execution.status = 'RUNNING'
    } else if (execution.status === 'WAITING') {
      if (execution.pendingAgent && scenario.execution !== 'agent-unknown') { execution.nodes.push(result(run.nodes[run.index], run.index)); run.index++; clearPending(execution); execution.status = 'RUNNING' }
      else if (execution.pendingWait && Date.now() >= run.deadline) { execution.status = 'FAILED'; execution.error = 'Mock 콜백 대기 시간 초과'; execution.finishedAt = now(); clearPending(execution); return execution }
      else return execution
    }
    const node = run.nodes[run.index]
    if (!node) { execution.status = 'SUCCEEDED'; execution.finishedAt = now(); return execution }
    if (scenario.execution === 'failure' && !['start', 'end'].includes(node.type)) { execution.nodes.push({ ...result(node, run.index), status: 'FAILED', ok: false, httpStatus: 500 }); execution.status = 'FAILED'; execution.error = '시나리오에서 지정한 Mock 실행 실패'; execution.finishedAt = now(); return execution }
    if (node.type === 'input') execution.pendingInput = { nodeId: node.id, nodeName: node.name, message: node.waitMsg ?? 'Mock 입력 테스트', fields: node.waitFields ?? [{ key: 'value', label: '값' }] }
    else if (node.type === 'wait') { execution.pendingWait = { nodeId: node.id, nodeName: node.name, timeoutSec: node.waitTimeoutSec ?? 120, receiveUrl: `http://127.0.0.1:5174/relay/${origin}/${execution.id}/cb/${node.id}` }; run.deadline = Date.now() + execution.pendingWait.timeoutSec * 1000 }
    else if (node.type === 'form') execution.pendingForm = { nodeId: node.id, nodeName: node.name, action: 'http://127.0.0.1:5174/__mock/form', method: node.formMethod ?? 'POST', fields: [] }
    else if (node.type === 'http' && node.reqMode === 'client') execution.pendingClient = { nodeId: node.id, nodeName: node.name, method: node.method ?? 'GET', url: 'http://127.0.0.1:5174/__mock/client-response', headers: {}, body: null, respType: node.respType ?? 'json' }
    else if (['http', 'tcp'].includes(node.type)) execution.pendingAgent = { taskId: randomUUID(), nodeId: node.id, nodeName: node.name, agent: node.executionAgent ?? origin, status: scenario.execution === 'agent-unknown' ? 'UNKNOWN' : 'RUNNING', deviceId: 'mock-device' }
    else { execution.nodes.push(result(node, run.index, node.type === 'set' ? Object.fromEntries((node.vars ?? []).map(v => [v.key, v.value])) : {})); run.index++; return execution }
    execution.status = 'WAITING'
    return execution
  }
  function clearPending(e) { for (const key of ['pendingInput', 'pendingWait', 'pendingForm', 'pendingClient', 'pendingAgent']) e[key] = null }
  function start(flow, body = {}) {
    const graph = body.versionNo ? versions.get(flow.id)?.find(v => v.versionNo === body.versionNo)?.value : flow.graph
    if (!graph) fail(404, '실행할 버전이 없습니다.')
    // 화면용 위상 순서. 분기 조건은 평가하지 않는다.
    const nodes = graph.nodes.filter(n => !['note', 'group'].includes(n.type) && (!body.onlyNodeId || n.id === body.onlyNodeId))
    const ordered = []
    const pending = new Set(nodes.map(n => n.id))
    while (pending.size) { const next = nodes.find(n => pending.has(n.id) && !graph.edges.some(e => e.to === n.id && pending.has(e.from))); if (!next) fail(400, '순환 그래프는 실행할 수 없습니다.'); pending.delete(next.id); ordered.push(next) }
    const envSource = body.envSource ?? origin
    const issue = environmentIssue(body.envName, envSource)
    if (issue) fail(400, issue)
    const execution = { id: randomUUID(), workspaceId: flow.workspaceId, flowId: flow.id, flowName: flow.name, flowVersionId: `${flow.id}-v${body.versionNo ?? flow.currentVersion}`, status: 'RUNNING', trigger: 'MANUAL', triggeredBy: 'mock-dev', startedAt: now(), finishedAt: null, error: null, nodes: [], environment: { source: envSource, name: body.envName ?? null } }
    executions.unshift(execution); running.set(execution.id, { nodes: structuredClone(ordered), index: 0 }); return execution
  }
  function preview(spec, key, values) {
    const message = spec?.messages?.find(m => m.key === key)
    if (!message) return { total: 0, hex: '', text: '', fields: [], errors: [{ message: '전문을 선택하세요.' }], warnings: [] }
    let text = ''; const fields = []
    for (const field of [...(spec.header ?? []), ...message.fields]) { const value = String(values?.[field.name] ?? ''); const rendered = field.pad?.startsWith('left') || field.type === 'numeric' ? value.padStart(field.len, field.pad === 'left/space' ? ' ' : '0') : value.padEnd(field.len, ' '); fields.push({ name: field.name, offset: Buffer.byteLength(text), len: field.len, actualBytes: Buffer.byteLength(value), value }); text += rendered.slice(0, field.len) }
    return { total: Buffer.byteLength(text), text, hex: Buffer.from(text).toString('hex'), fields, errors: [], warnings: ['Mock 미리보기는 UTF-8 샘플이며 실제 코덱·레거시 문자셋을 검증하지 않습니다.'] }
  }
  return (method, url, body, workspaceId) => {
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/v1(?:\/remote)?/, ''))
    const [resource, id, action, no] = path.split('/').filter(Boolean)
    if (path.startsWith('/relay/')) { const e = executions.find(e => e.id === id); if (!e?.pendingWait || e.pendingWait.nodeId !== no) fail(404, '대기 실행이 없습니다.'); advance(e, { nodeId: e.pendingWait.nodeId, callback: { method, body: JSON.stringify(body) } }); return { received: true } }
    if (path.startsWith('/mock/')) {
      const match = path.match(/^\/mock\/(?:remote\/)?ws\/([^/]+)\/([^/]+)(.*)$/)
      if (!match) fail(404, 'Mock 주소가 없습니다.')
      const item = scoped(mocks, match[1]).find(m => m.slug === match[2]); if (!item || !item.enabled) fail(404, 'Mock이 꺼져 있습니다.')
      const route = item.spec.routes?.find(r => (r.method === method || r.method === 'ANY') && r.path === (match[3] || '/')); const rule = route?.rules?.[0]
      const status = rule?.status ?? 404; const bodyText = rule?.body ?? 'Mock 규칙이 없습니다.'
      const list = logs.get(item.id) ?? []; list.unshift({ at: now(), method, path: match[3], query: Object.fromEntries(url.searchParams), headers: {}, bodyText: JSON.stringify(body), matchedRuleId: rule?.id ?? null, status, delayMs: 0, callbackFired: false }); logs.set(item.id, list.slice(0, 100))
      if (rule?.contentType === 'html') return { __html: bodyText }
      let value = bodyText; try { value = JSON.parse(bodyText) } catch { /* 문자열 응답 */ }
      return { __status: status, __body: value }
    }
    if (resource === 'agent' && id === 'inspect' && method === 'POST') {
      const issue = environmentIssue(body.envName, body.envSource ?? origin)
      const issues = [...(scenario.execution === 'inspection-error' ? ['Mock: 대상 자원을 확인하지 못했습니다.'] : []), ...(issue ? [issue] : [])]
      return { runtime: origin, ready: issues.length === 0, issues, dependencyHashes: {}, targetDiagnostics: { resolvedTarget: body.node?.type === 'tcp' ? `${body.node.tcpHost ?? 'mock-host'}:${body.node.tcpPort ?? 19000}` : `${body.node?.baseUrl ?? ''}${body.node?.path ?? ''}`, source: 'workflow-address', requester: body.node?.reqMode === 'client' ? 'browser' : 'agent', environment: body.envName ?? null, configurationReady: issues.length === 0, warnings: ['Mock 구성 확인 · 실제 네트워크 접속 없음'] } }
    }
    if ((path === '/protocols/preview' || path === '/agent/tcp-preview' || path === '/agent/tcp-preview/resources' || resource === 'flows' && action === 'nodes' && path.endsWith('/tcp-preview')) && method === 'POST') { const node = body.node ?? body; return preview(body.spec ?? protocols.find(p => p.id === node.protocolId)?.spec, body.key ?? node.tcpMessage, body.values ?? node.tcpValues) }
    if (resource === 'flows' && action === 'runs' && method === 'POST') return start(find(flows, id, workspaceId), body)
    if (resource === 'executions' && id) {
      const e = find(executions, id, workspaceId)
      if (!action && method === 'GET') return advance(e)
      if (action === 'resume' && method === 'POST') return advance(e, body)
      if (action === 'rerun' && method === 'POST') return start(find(flows, e.flowId, workspaceId))
    }
    if (resource === 'suites' && id === 'run' && method === 'POST') return scoped(flows, workspaceId).filter(f => body.flowIds ? body.flowIds.includes(f.id) : f.folderId === body.folderId).map(f => { const e = start(f); for (let i = 0; i < 200 && e.status === 'RUNNING'; i++) advance(e); return { flowId: f.id, flowName: f.name, executionId: e.id, status: e.status, error: e.error } })
    if (resource === 'flows' && action === 'triggers') {
      find(flows, id, workspaceId)
      if (!no && method === 'GET') return triggers.filter(t => t.flowId === id)
      if (!no && method === 'POST') { const item = { ...body, id: randomUUID(), flowId: id, enabled: body.enabled ?? true, webhookToken: body.type === 'WEBHOOK' ? randomUUID() : null, createdAt: now(), lastFiredAt: null, lastStatus: null }; triggers.push(item); return item }
      const index = triggers.findIndex(t => t.id === no && t.flowId === id); if (index < 0) fail(404, '트리거가 없습니다.')
      if (method === 'PUT') { Object.assign(triggers[index], body); return triggers[index] }
      if (method === 'DELETE') { triggers.splice(index, 1); return {} }
    }
    if (resource === 'webhooks' && method === 'POST') { const trigger = triggers.find(t => t.webhookToken === id && t.enabled); if (!trigger) fail(404, '웹훅이 없습니다.'); return start(flows.find(f => f.id === trigger.flowId)) }
    if (resource === 'mock-servers' && id === 'fleet' && method === 'GET') return { workspaces: workspaces.map(w => ({ ...w, mine: true })), servers: mocks.map(m => ({ ...mockSummary(m), readable: true, myRole: 'OWNER', listening: m.enabled, usedBy: [] })), ports: mocks.filter(m => m.enabled).map(m => ({ port: m.spec.tcp?.port ?? 5174, kind: m.kind === 'TCP' ? 'TCP' : 'HTTP', state: 'LISTENING', mockId: m.id, workspaceId: m.workspaceId, readable: true, count: 1 })), httpPort: 5174, contextPath: '', generatedAt: now() }
    if (resource === 'mock-servers' && id && !['fleet', 'usages', 'slug-check'].includes(id)) {
      const item = find(mocks, id, workspaceId)
      if (action === 'tcp-sessions') {
        if (!item.spec.tcp) fail(400, 'TCP Mock이 아닙니다.')
        if (!item.enabled) { tcpSessions.delete(id); if (method === 'GET') return []; fail(404, '연결이 종료되었습니다.') }
        if (!tcpSessions.has(id)) {
          const idleTimeoutMs = protocols.find(p => p.id === item.spec.tcp.protocolId)?.spec.transport?.idleTimeoutMs ?? 30000
          tcpSessions.set(id, [
            { id: `${origin}-waiting-demo`, remoteAddress: '127.0.0.1', remotePort: 53001, connectedAt: new Date(Date.now() - 90000).toISOString(), lastActivityAt: now(), idleTimeoutMs, state: 'waiting', expiresAt: new Date(Date.now() + idleTimeoutMs).toISOString(), receivedMessages: 20 },
            { id: `${origin}-processing-demo`, remoteAddress: '::1', remotePort: 53002, connectedAt: now(), lastActivityAt: now(), idleTimeoutMs, state: 'processing', expiresAt: null, receivedMessages: 1 },
          ])
        }
        const list = tcpSessions.get(id).filter(session => !session.expiresAt || Date.parse(session.expiresAt) > Date.now())
        tcpSessions.set(id, list)
        const view = session => ({ ...session, remainingMs: session.expiresAt ? Math.max(0, Date.parse(session.expiresAt) - Date.now()) : null })
        if (!no && method === 'GET') return list.map(view)
        if (no && path.endsWith('/extend') && method === 'POST') {
          const session = list.find(session => session.id === no)
          if (!session) fail(404, '연결이 종료되었습니다.')
          if (session.state !== 'waiting') fail(400, '대기 중인 연결만 연장할 수 있습니다.')
          if (!Number.isInteger(body.extendMs) || body.extendMs < 1000 || body.extendMs > 3600000) fail(400, '연장 시간은 1초~1시간이어야 합니다.')
          if (Date.parse(session.expiresAt) - Date.now() + body.extendMs > 3600000) fail(400, '연장 후 남은 대기 시간은 최대 1시간입니다.')
          session.expiresAt = new Date(Date.parse(session.expiresAt) + body.extendMs).toISOString()
          return view(session)
        }
      }
      if (['requests', 'tcp-log'].includes(action)) { if (method === 'GET') return logs.get(id) ?? []; if (method === 'DELETE') { logs.delete(id); return {} } }
      if (action === 'reset' && method === 'POST') { logs.delete(id); return {} }
      if (action === 'codec-try' && method === 'POST') return { result: body.message, headers: body.headers ?? {}, fields: {}, steps: [] }
      if (action === 'tcp-send' && method === 'POST') { const protocol = protocols.find(p => p.id === item.spec.tcp?.protocolId); const request = preview(protocol?.spec, body.key, body.values); const response = { key: body.key, disc: null, header: {}, body: body.values, text: request.text, hex: request.hex, bytes: request.total, chunks: [request.total], partial: false, warnings: ['Mock TCP 응답 · 실제 소켓 전송 없음'] }; const journal = logs.get(id) ?? []; journal.unshift({ at: now(), dir: 'in', key: body.key, fields: body.values, chunks: [request.total], partial: false, ruleId: null, note: '프론트 Mock 전문', level: 'info', text: request.text, hex: request.hex, bytes: request.total, source: 'mock' }); logs.set(id, journal); return { request, response, elapsedMs: 120 } }
    }
    if (path === '/transforms' && method === 'GET') return origin === 'server' ? scoped(plugins, workspaceId).filter(p => p.live && p.kind === 'transform').map(p => summary(p).meta) : []
    if (resource === 'transforms' && action === 'preview' && method === 'POST') return { ok: true, outputs: { result: body.inputs?.input ?? 'Mock 변환 결과' } }
    if (path === '/codecs' && method === 'GET') return scoped(plugins, workspaceId).filter(p => p.live && p.kind !== 'transform').map(p => ({ id: p.pluginId, label: p.name, layer: p.kind === 'fieldCodec' ? 'field' : 'message', params: [] }))
    if (resource === 'plugins') {
      if (id === 'api' && method === 'GET') return [{ path: 'fl.log', signature: 'fl.log(message)', doc: 'Mock에서는 코드를 실행하지 않습니다.', example: "fl.log('테스트')" }]
      if (id === 'scripts' && action === 'try' && method === 'POST') return { meta, outputs: { result: body.inputs?.input ?? 'Mock 변환 결과' }, result: body.value ?? null, bytesB64: body.bytesB64 ?? null, logs: ['프론트 Mock 응답 · 입력한 스크립트는 실행하지 않았습니다.'], durationMs: 120 }
      if (id === 'scripts' && !action && method === 'GET') return scoped(plugins, workspaceId).filter(p => !url.searchParams.get('status') || p.status === url.searchParams.get('status')).map(summary)
      if (id === 'scripts' && action && !no && ['GET', 'PUT'].includes(method)) {
        const item = find(plugins, action, workspaceId)
        if (method === 'PUT') Object.assign(item, body, { updatedAt: now() })
        return summary(item)
      }
      if (id === 'scripts' && action && no) {
        const item = find(plugins, action, workspaceId)
        if (no === 'usages' && method === 'GET') return []
        if (method === 'PUT' && no === 'sample') { item.sampleJson = body.sampleJson; return {} }
        if (method === 'POST' && ['submit', 'withdraw', 'approve', 'reject'].includes(no)) { item.status = ({ submit: 'PENDING', withdraw: 'DRAFT', approve: 'APPROVED', reject: 'REJECTED' })[no]; item.reviewNote = body.note ?? null; item.live = no === 'approve' || item.live; item.submittedBy = 'mock-dev'; if (no === 'approve') item.liveSource = item.source; return summary(item) }
      }
    }
    if (resource === 'admin') {
      if (id === 'me') return { username: 'mock-dev', admin: scenario.role !== 'viewer' && scenario.role !== 'editor' && scenario.role !== 'pending', authenticated: true, pendingCount: users.filter(u => u.status === 'PENDING').length, pendingPlugins: plugins.filter(p => p.status === 'PENDING').length, myStatus: scenario.role === 'pending' ? 'PENDING' : 'APPROVED' }
      if (id === 'users') { if (scenario.role && scenario.role !== 'admin') fail(403, 'Mock: 관리자 권한이 필요합니다.'); if (!action && method === 'GET') return users; const index = users.findIndex(u => u.username === action); if (index < 0) fail(404, '사용자가 없습니다.'); if (method === 'PUT') { Object.assign(users[index], body); return users[index] } if (method === 'DELETE') { users.splice(index, 1); return {} } }
    }
    if (resource === 'assistant') {
      if (id === 'config') return { available: true, usingRealLlm: false, model, authMode: 'stub' }
      if (id === 'skills') { if (method === 'PUT') skills.user = body.user; return skills }
      if (id === 'instructions' && method === 'PUT') { skills.instructions = body.instructions; return skills }
      if (['chat', 'mock', 'protocol'].includes(id) && method === 'POST') return { reply: '프론트 테스트용 고정 AI 응답입니다. 실제 모델 호출은 수행하지 않았습니다.', graph: id === 'chat' ? body.graph ?? structuredClone(flows[0].graph) : null, spec: id === 'mock' ? body.spec ?? structuredClone(mocks[0].spec) : id === 'protocol' ? body.spec ?? structuredClone(protocols[0].spec) : null, stub: true, model }
      if (id === 'oauth') {
        if (action === 'device') { oauth = true; return { userCode: 'MOCK-CODE', verificationUri: 'http://127.0.0.1:5174/__mock', expiresIn: 900, intervalSec: 1 } }
        if (action === 'disconnect') { oauth = false; return {} }
        if (action === 'status') return { connected: oauth, pending: false, error: null }
        if (action === 'models') return { models: [{ id: 'mock-model', name: 'Mock 모델', premium: false }, { id: 'mock-premium', name: 'Mock 프리미엄', premium: true }], current: model }
        if (action === 'model' && method === 'PUT') { model = body.model; return { current: model } }
        if (action === 'info') return { connected: oauth, login: oauth ? 'mock-dev' : null, avatarUrl: null, plan: oauth ? 'Mock 요금제' : null, sku: 'mock', chatEnabled: oauth, agentEnabled: oauth, quotaResetDate: null, quotas: [{ id: 'premium', label: 'Mock 요청', unlimited: false, percentRemaining: 80, remaining: 80, entitlement: 100, used: 20, overagePermitted: false }], currentModel: model, tokenExpiresAt: Date.now() + 3600000 }
      }
      if (id === 'sessions') {
        if (!action && method === 'GET') return sessions.map(s => ({ ...s, messageCount: s.messages.length }))
        if (!action && method === 'POST') { const session = { id: randomUUID(), title: body.title ?? 'Mock 대화', messages: body.messages ?? [], updatedAt: now() }; sessions.unshift(session); return session }
        const index = sessions.findIndex(s => s.id === action); if (index < 0) fail(404, '대화가 없습니다.')
        if (method === 'DELETE') { sessions.splice(index, 1); return {} }
        if (method === 'PUT') Object.assign(sessions[index], body, { updatedAt: now() })
        return sessions[index]
      }
    }
    if (resource === 'workspaces' && id) {
      const workspace = workspaces.find(w => w.id === id); if (!workspace) fail(404, '공간이 없습니다.')
      if (method === 'GET' && action === 'export') return { kind: 'flowlink-workspace', version: 1, name: workspace.name, folders: scoped(folders, id).map(f => ({ ref: f.id, name: f.name, parentRef: f.parentId })), flows: scoped(flows, id).map(f => ({ name: f.name, description: f.description, folderRef: f.folderId, graph: f.graph })), mocks: scoped(mocks, id) }
      if (method === 'POST' && action === 'import') {
        if (![body.flows, body.folders, body.mocks].every(Array.isArray)) fail(400, 'folders, flows, mocks 배열이 필요합니다.')
        if (body.kind !== 'flowlink-workspace' || body.flows.some(f => !Array.isArray(f.graph?.nodes) || !Array.isArray(f.graph?.edges)) || body.mocks.some(m => !m.spec)) fail(400, '공간 가져오기 형식이 올바르지 않습니다.')
        const folderIds = new Map()
        const freshFolders = body.folders.map(f => { const newId = randomUUID(); folderIds.set(f.ref, newId); return { ...f, id: newId, workspaceId: id } })
        freshFolders.forEach(f => { f.parentId = folderIds.get(f.parentRef) ?? null }); folders.push(...freshFolders)
        for (const [items, list] of [[body.flows, flows], [body.mocks, mocks]]) for (const incoming of items) { const item = { ...structuredClone(incoming), id: randomUUID(), workspaceId: id, folderId: folderIds.get(incoming.folderRef) ?? null, currentVersion: 1, createdAt: now(), updatedAt: now(), myRole: 'OWNER' }; list.push(item); versions.set(item.id, [version(item, item.graph ?? item.spec)]) }
        return { folders: body.folders.length, flows: body.flows.length, mocks: body.mocks.length, warnings: ['Mock 입출력 · 운영 호환성은 실제 서버에서 확인하세요.'] }
      }
      if (!action && method === 'DELETE') { if (['public', 'local'].includes(id)) fail(400, '기본 공간은 삭제할 수 없습니다.'); const target = url.searchParams.get('moveTo') ?? 'public'; if (!workspaces.some(w => w.id === target)) fail(404, '이동할 공간이 없습니다.'); for (const list of [flows, folders, mocks, protocols, environments, plugins]) list.filter(i => i.workspaceId === id).forEach(i => { i.workspaceId = target }); workspaces.splice(workspaces.indexOf(workspace), 1); members.delete(id); return {} }
    }
  }
}
