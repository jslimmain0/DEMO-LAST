import { appBase } from '../lib/appBase'
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios'
import type {
  AssistantChatRequest,
  AssistantChatResponse,
  AssistantConfig,
  CopilotInfo,
  CreateFlowRequest,
  ExecutionDetail,
  ExecutionSummary,
  FlowDetail,
  FlowGraph,
  FlowSummary,
  FlowVersionSummary,
  FolderSummary,
  GraphNode,
  ResumeRequest,
  DeviceStart,
  InstructionsUpdateRequest,
  ModelsView,
  OAuthStatus,
  SaveSessionRequest,
  SessionDetail,
  SessionSummary,
  RunRequest,
  SaveVersionRequest,
  SingleNodeRunResult,
  SkillsUpdateRequest,
  SkillsView,
} from './types'

export interface SecretView { name: string; environment: string | null; createdAt: string | null }
export interface SuiteRunItem { flowId: string; flowName: string; executionId: string | null; status: string; error: string | null }
export interface WorkspaceView { id: string; name: string; kind: 'PUBLIC' | 'PERSONAL' | 'TEAM'; myRole: 'OWNER' | 'EDITOR' | 'VIEWER'; canManage: boolean }
export interface WorkspaceMemberView { username: string; role: 'OWNER' | 'EDITOR' | 'VIEWER' }
export interface WorkspaceImportResult { folders: number; flows: number; mocks: number; warnings: string[] }
export interface AdminMeView { username: string; admin: boolean; authenticated: boolean; pendingCount: number; pendingPlugins: number; myStatus: 'GUEST' | 'PENDING' | 'APPROVED' | 'BLOCKED' }
export type UserStatus = 'PENDING' | 'APPROVED' | 'BLOCKED'
export interface AdminUserView { username: string; globalRole: 'ADMIN' | 'MEMBER'; status: UserStatus; lastSeenAt: string | null; createdAt: string | null }
export interface AdminWorkspaceView {
  id: string; name: string; kind: 'PERSONAL' | 'TEAM'; ownerUsername: string | null
  createdAt: string | null; flowCount: number; members: WorkspaceMemberView[]; mockCount: number
}
export interface AdminWorkspacesResponse { publicFlowCount: number; workspaces: AdminWorkspaceView[]; publicMockCount: number }
export interface RelaySetting {
  value: string | null
  effective: string
  auto: string | null
}
export interface EnvView { name: string; vars: Record<string, string>; updatedAt: string | null }

export const localApi = axios.create({ baseURL: `${appBase()}/api/v1`, headers: { 'Content-Type': 'application/json' } })
export const serverApi = axios.create({ baseURL: `${appBase()}/api/v1/remote`, headers: { 'Content-Type': 'application/json' } })
// Authentication discovery always addresses this process. Workspace calls use a captured transport.
export const http = localApi

export function createApi(transport: AxiosInstance, workspaceId = 'public', resourceBase?: string, expectedLogin?: string | null) {
  const scoped = (config?: AxiosRequestConfig) => ({ ...config, params: { workspaceId, ...config?.params },
    headers: { ...config?.headers, ...(expectedLogin ? { 'X-FlowLink-Account': expectedLogin, 'X-FlowLink-Server': resourceBase } : {}) },
  })
  const http = {
    get: <T>(url: string, config?: AxiosRequestConfig) => transport.get<T>(url, scoped(config)),
    post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => transport.post<T>(url, data, scoped(config)),
    put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => transport.put<T>(url, data, scoped(config)),
    patch: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => transport.patch<T>(url, data, scoped(config)),
    delete: <T>(url: string, config?: AxiosRequestConfig) => transport.delete<T>(url, scoped(config)),
  }
const flowsApi = {
  list: (workspaceId?: string) =>
    http.get<FlowSummary[]>('/flows', { params: workspaceId && workspaceId !== 'public' ? { workspaceId } : undefined }).then((r) => r.data),
  get: (id: string) => http.get<FlowDetail>(`/flows/${id}`).then((r) => r.data),
  create: (body: CreateFlowRequest) => http.post<FlowDetail>('/flows', { workspaceId, ...body }).then((r) => r.data),
  remove: (id: string) => http.delete(`/flows/${id}`).then(() => undefined),
  saveVersion: (id: string, body: SaveVersionRequest) =>
    http.post<FlowVersionSummary>(`/flows/${id}/versions`, body).then((r) => r.data),
  listVersions: (id: string) =>
    http.get<FlowVersionSummary[]>(`/flows/${id}/versions`).then((r) => r.data),
  getVersion: (id: string, no: number) =>
    http.get<FlowGraph>(`/flows/${id}/versions/${no}`).then((r) => r.data),
  // 📌 보존 토글 — 커밋처럼 남긴 버전은 자동 보존 정책에서 영구 제외
  pinVersion: (id: string, no: number, pinned: boolean) =>
    http.put<FlowVersionSummary>(`/flows/${id}/versions/${no}/pin`, { pinned }).then((r) => r.data),
  restoreVersion: (id: string, no: number) =>
    http.post<FlowVersionSummary>(`/flows/${id}/versions/${no}/restore`).then((r) => r.data),
  importFlow: (graph: unknown) =>
    http.post<FlowDetail>('/flows/import', graph).then((r) => r.data),
  move: (id: string, folderId: string | null) =>
    http.put(`/flows/${id}/folder`, { folderId }).then(() => undefined),
  updateMeta: (id: string, body: { name?: string; description?: string }) =>
    http.patch<FlowDetail>(`/flows/${id}`, body).then((r) => r.data),
}

const triggersApi = {
  list: (flowId: string) =>
    http.get<import('./types').TriggerView[]>(`/flows/${flowId}/triggers`).then((r) => r.data),
  create: (flowId: string, body: import('./types').CreateTriggerRequest) =>
    http.post<import('./types').TriggerView>(`/flows/${flowId}/triggers`, body).then((r) => r.data),
  update: (flowId: string, id: string, body: { enabled?: boolean; cron?: string; versionNo?: number; input?: Record<string, unknown> }) =>
    http.put<import('./types').TriggerView>(`/flows/${flowId}/triggers/${id}`, body).then((r) => r.data),
  remove: (flowId: string, id: string) =>
    http.delete(`/flows/${flowId}/triggers/${id}`).then(() => undefined),
}

const secretsApi = {
  list: () => http.get<SecretView[]>('/secrets').then((r) => r.data),
  put: (name: string, value: string, environment?: string | null) =>
    http.put<SecretView>(`/secrets/${encodeURIComponent(name)}`, { value, environment: environment || null }).then((r) => r.data),
  remove: (name: string, environment?: string | null) =>
    http.delete(`/secrets/${encodeURIComponent(name)}`, { params: environment ? { environment } : undefined }).then(() => undefined),
}

const suitesApi = {
  run: (body: { flowIds?: string[]; folderId?: string }) =>
    http.post<SuiteRunItem[]>('/suites/run', body).then(r => r.data),
}

const transformsApi = {
  list: () => http.get<import('./types').TransformInfo[]>('/transforms').then((r) => r.data),
  // 미리보기 — 샘플 입력/설정으로 변환 결과를 즉시 확인(순수 계산)
  preview: (id: string, body: { inputs: Record<string, string>; config: Record<string, string>; environment?: string | null }) =>
    http.post<import('./types').TransformPreviewResponse>(`/transforms/${id}/preview`, body).then((r) => r.data),
}

const pluginsApi = {
  api: () => http.get<import('./types').FlApiEntry[]>('/plugins/api').then((r) => r.data),
  list: (status?: import('./types').PluginScriptStatus) => http.get<import('./types').PluginScriptSummary[]>('/plugins/scripts', { params: status ? { status } : {} }).then((r) => r.data),
  get: (id: string) => http.get<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}`).then((r) => r.data),
  create: (body: { name?: string; source: string }) => http.post<import('./types').PluginScriptDetail>('/plugins/scripts', { ...body, workspaceId }).then((r) => r.data),
  update: (id: string, body: { name?: string; source?: string }) => http.put<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}`, body).then((r) => r.data),
  tryRun: (body: import('./types').PluginTryRequest) => http.post<import('./types').PluginTryResult>('/plugins/scripts/try', body).then((r) => r.data),
  saveSample: (id: string, sampleJson: string) => http.put(`/plugins/scripts/${id}/sample`, { sampleJson }).then(() => undefined),
  submit: (id: string) => http.post<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}/submit`).then((r) => r.data),
  withdraw: (id: string) => http.post<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}/withdraw`).then((r) => r.data),
  approve: (id: string) => http.post<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}/approve`).then((r) => r.data),
  reject: (id: string, note: string) => http.post<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}/reject`, { note }).then((r) => r.data),
  remove: (id: string) => http.delete(`/plugins/scripts/${id}`).then(() => undefined),
  usages: (id: string) => http.get<import('./types').PluginUsageRef[]>(`/plugins/scripts/${id}/usages`).then((r) => r.data),
}

const foldersApi = {
  list: (workspaceId?: string) =>
    http.get<FolderSummary[]>('/folders', { params: workspaceId && workspaceId !== 'public' ? { workspaceId } : undefined }).then((r) => r.data),
  create: (name: string, parentId: string | null = null, workspaceId?: string) =>
    http.post<FolderSummary>('/folders', { name, parentId, workspaceId: workspaceId && workspaceId !== 'public' ? workspaceId : null }).then((r) => r.data),
  // 폴더 재배치(드래그 이동) — parentId=null 은 루트로. 자기/하위 아래로는 400.
  move: (id: string, parentId: string | null) =>
    http.put<FolderSummary>(`/folders/${id}/parent`, { parentId }).then((r) => r.data),
  rename: (id: string, name: string) => http.patch<FolderSummary>(`/folders/${id}`, { name }).then((r) => r.data),
  remove: (id: string) => http.delete(`/folders/${id}`).then(() => undefined),
}

const workspacesApi = {
  list: () => http.get<WorkspaceView[]>('/workspaces').then((r) => r.data),
  create: (name: string) => http.post<WorkspaceView>('/workspaces', { name }).then((r) => r.data),
  remove: (id: string, moveTo?: string) => http.delete(`/workspaces/${id}`, { params: moveTo ? { moveTo } : undefined }).then(() => undefined),
  members: (id: string) => http.get<WorkspaceMemberView[]>(`/workspaces/${id}/members`).then((r) => r.data),
  putMember: (id: string, username: string, role: string) =>
    http.put<WorkspaceMemberView[]>(`/workspaces/${id}/members`, { username, role }).then((r) => r.data),
  removeMember: (id: string, username: string) =>
    http.delete<WorkspaceMemberView[]>(`/workspaces/${id}/members/${encodeURIComponent(username)}`).then((r) => r.data),
  // 워크스페이스 통째 내보내기/가져오기(폴더+워크플로+Mock) — 텍스트 복붙용 JSON 번들
  exportBundle: (id: string) => http.get<unknown>(`/workspaces/${id}/export`).then((r) => r.data),
  importBundle: (id: string, bundle: unknown) =>
    http.post<WorkspaceImportResult>(`/workspaces/${id}/import`, bundle).then((r) => r.data),
}

const adminApi = {
  me: () => http.get<AdminMeView>('/admin/me').then((r) => r.data),
  users: () => http.get<AdminUserView[]>('/admin/users').then((r) => r.data),
  putUser: (username: string, body: { globalRole?: string; status?: string }) =>
    http.put<AdminUserView>(`/admin/users/${encodeURIComponent(username)}`, body).then((r) => r.data),
  removeUser: (username: string) =>
    http.delete(`/admin/users/${encodeURIComponent(username)}`).then(() => undefined),
  // 팀·권한 콘솔 — 전체 워크스페이스(팀+개인) + 멤버 + 워크플로 수 1왕복
  workspaces: () => http.get<AdminWorkspacesResponse>('/admin/workspaces').then((r) => r.data),
}

const mocksApi = {
  list: (workspaceId?: string) =>
    http.get<import('./types').MockServerSummary[]>('/mock-servers', { params: workspaceId && workspaceId !== 'public' ? { workspaceId } : undefined }).then((r) => r.data),
  get: (id: string) => http.get<import('./types').MockServerDetail>(`/mock-servers/${id}`).then((r) => r.data),
  // slug 가용성은 선택 워크스페이스 안에서 검사한다.
  slugCheck: (slug: string) =>
    http.get<{ slug: string; available: boolean }>('/mock-servers/slug-check', { params: { slug } }).then((r) => r.data),
  create: (body: { name: string; slug: string; type?: 'HTTP' | 'TCP'; workspaceId?: string | null }) =>
    http.post<import('./types').MockServerDetail>('/mock-servers', { workspaceId, ...body }).then((r) => r.data),
  update: (id: string, body: { name?: string; enabled?: boolean; workspaceId?: string | null }) =>
    http.patch<import('./types').MockServerDetail>(`/mock-servers/${id}`, body).then((r) => r.data),
  // spec 저장 — 내용이 바뀌면 버전 스냅샷(note=메시지, pinned=📌 보존)
  updateSpec: (id: string, spec: import('./types').MockServerSpec, opts?: { note?: string; pinned?: boolean }) =>
    http.put<import('./types').MockServerDetail>(`/mock-servers/${id}/spec`, { spec, note: opts?.note, pinned: opts?.pinned }).then((r) => r.data),
  // 사용처(이 워크스페이스 Mock 을 호출하는 워크플로) — mockId → [{id,name}]
  usages: (workspaceId?: string) =>
    http.get<Record<string, import('./types').MockFlowRef[]>>('/mock-servers/usages', { params: workspaceId && workspaceId !== 'public' ? { workspaceId } : undefined }).then((r) => r.data),
  // 서버 현황 — 모든 워크스페이스의 Mock + 워크스페이스 + 포트 맵(접근 불가 워크스페이스는 이름·포트·상태만)
  fleet: () => http.get<import('./types').MockFleet>('/mock-servers/fleet').then((r) => r.data),
  versions: (id: string) => http.get<import('./types').MockVersionSummary[]>(`/mock-servers/${id}/versions`).then((r) => r.data),
  version: (id: string, no: number) => http.get<import('./types').MockServerSpec>(`/mock-servers/${id}/versions/${no}`).then((r) => r.data),
  restoreVersion: (id: string, no: number) => http.post<import('./types').MockVersionSummary>(`/mock-servers/${id}/versions/${no}/restore`).then((r) => r.data),
  pinVersion: (id: string, no: number, pinned: boolean) => http.put<import('./types').MockVersionSummary>(`/mock-servers/${id}/versions/${no}/pin`, { pinned }).then((r) => r.data),
  remove: (id: string) => http.delete(`/mock-servers/${id}`).then(() => undefined),
  requests: (id: string) => http.get<import('./types').MockRequestLog[]>(`/mock-servers/${id}/requests`).then((r) => r.data),
  clearRequests: (id: string) => http.delete(`/mock-servers/${id}/requests`).then(() => undefined),
  reset: (id: string) => http.post(`/mock-servers/${id}/reset`).then(() => undefined),
  state: (id: string) => http.get<import('./types').MockStateView>(`/mock-servers/${id}/state`).then((r) => r.data),
  // TCP 전문 로그 — 리스너가 주고받은 전문(수신/송신, mock·proxy·none)
  tcpLog: (id: string) => http.get<import('./types').TcpLogEntry[]>(`/mock-servers/${id}/tcp-log`).then((r) => r.data),
  clearTcpLog: (id: string) => http.delete(`/mock-servers/${id}/tcp-log`).then(() => undefined),
  // 보내보기 — 저장된 mock 의 리스너로 전문을 조립해 보내고 응답을 프로토콜로 디코딩
  tcpSend: (id: string, body: { key: string; values: Record<string, string> }) =>
    http.post<import('./types').TcpSendResult>(`/mock-servers/${id}/tcp-send`, body).then((r) => r.data),
  // 코덱 시험(HTTP) — 미저장 코덱 + 샘플 전문 → 단계별 입력/출력(서버가 실제 시크릿으로 계산, 결과는 마스킹)
  codecTry: (id: string, body: { codec: import('./types').MockCodecSpec; environment?: string | null; side: 'request' | 'response'; message: string; headers?: Record<string, string>; contentType?: string }) =>
    http.post<import('./types').MockCodecTryResult>(`/mock-servers/${id}/codec-try`, body).then((r) => r.data),
}

const protocolsApi = {
  list: () => http.get<import('./types').ProtocolSummary[]>('/protocols').then((r) => r.data),
  get: (id: string) => http.get<import('./types').ProtocolDetail>(`/protocols/${id}`).then((r) => r.data),
  create: (name: string, spec: import('./types').ProtocolSpec) => http.post<import('./types').ProtocolDetail>('/protocols', { name, spec, workspaceId }).then((r) => r.data),
  update: (id: string, body: { name?: string; spec?: import('./types').ProtocolSpec }) => http.put<import('./types').ProtocolDetail>(`/protocols/${id}`, body).then((r) => r.data),
  remove: (id: string) => http.delete(`/protocols/${id}`).then(() => undefined),
  // 편집 중 spec 으로 조립 미리보기(저장 없음) — 검증 실패는 errors 로 온다
  preview: (body: { spec: import('./types').ProtocolSpec; key: string; values: Record<string, string>; direction?: 'send' | 'recv'; environment?: string | null }) =>
    http.post<import('./types').ProtocolPreview>('/protocols/preview', body).then((r) => r.data),
}

const codecsApi = { list: () => http.get<import('./types').CodecInfo[]>('/codecs').then((r) => r.data) }

const environmentsApi = {
  list: () => http.get<EnvView[]>('/environments').then((r) => r.data),
  put: (name: string, vars: Record<string, string>) => http.put<EnvView>(`/environments/${encodeURIComponent(name)}`, { vars }).then((r) => r.data),
  rename: (name: string, to: string) => http.post<EnvView>(`/environments/${encodeURIComponent(name)}/rename`, { to }).then((r) => r.data),
  remove: (name: string) => http.delete(`/environments/${encodeURIComponent(name)}`).then(() => undefined),
}

const runInputApi = {
  get: (flowId: string) => http.get<{ vars: Record<string, string> }>(`/flows/${flowId}/run-input`).then((r) => r.data),
  put: (flowId: string, vars: Record<string, string>) => http.put<{ vars: Record<string, string> }>(`/flows/${flowId}/run-input`, { vars }).then((r) => r.data),
}

const settingsApi = {
  relay: () => http.get<RelaySetting>('/settings/relay').then((r) => r.data),
  saveRelay: (value: string | null) => http.put<RelaySetting>('/settings/relay', { value }).then((r) => r.data),
  notify: () => http.get<{ value: string | null }>('/settings/notify').then((r) => r.data),
  saveNotify: (value: string | null) => http.put<{ value: string | null }>('/settings/notify', { value }).then((r) => r.data),
}

const runsApi = {
  run: (flowId: string, body?: RunRequest) =>
    http.post<ExecutionDetail>(`/flows/${flowId}/runs`, body ?? {}).then((r) => r.data),
  get: (executionId: string) =>
    http.get<ExecutionDetail>(`/executions/${executionId}`).then((r) => r.data),
  // 실행 경과 애니메이션용 — 방금 시작된 실행의 id 를 찾기 위해 이 플로우의 최근 실행을 조회
  listForFlow: (flowId: string, limit = 1) =>
    http.get<ExecutionSummary[]>(`/flows/${flowId}/runs`, { params: { limit } }).then((r) => r.data),
  resume: (executionId: string, body: ResumeRequest) =>
    http.post<ExecutionDetail>(`/executions/${executionId}/resume`, body).then((r) => r.data),
  // 단일 노드도 일반 실행 이력과 네이티브 에이전트 경로를 사용한다. 조회 실패 후 재전송하지 않는다.
  runNode: async (flowId: string, nodeId: string, body?: RunRequest & { upstream?: Record<string, Record<string, unknown>> }): Promise<SingleNodeRunResult> => {
    let detail = (await http.post<ExecutionDetail>(`/flows/${flowId}/runs`, { ...body, onlyNodeId: nodeId })).data
    const deadline = Date.now() + 120_000
    while (['PENDING', 'RUNNING', 'WAITING'].includes(detail.status)) {
      if (detail.pendingAgent?.status === 'UNKNOWN') throw new Error(`에이전트 응답이 끊겨 결과를 확인할 수 없습니다. 자동으로 재실행하지 않습니다. 실행 이력 ${detail.id}에서 확인하세요.`)
      if (detail.pendingForm || detail.pendingInput || detail.pendingClient) throw new Error(`사용자 화면 처리가 필요합니다. 실행 이력 ${detail.id}에서 에디터로 이어가세요.`)
      if (Date.now() >= deadline) throw new Error(`실행 상태 확인 시간이 지났습니다. 실행은 계속될 수 있습니다. 실행 이력 ${detail.id}에서 확인하세요.`)
      await new Promise(resolve => setTimeout(resolve, 1000))
      try { detail = (await http.get<ExecutionDetail>(`/executions/${detail.id}`)).data }
      catch { throw new Error(`실행 상태를 조회하지 못했습니다. 자동으로 재실행하지 않습니다. 실행 이력 ${detail.id}에서 확인하세요.`) }
    }
    const result = detail.nodes.find(n => n.nodeId === nodeId)
    if (!result) throw new Error(`노드 실행 결과가 없습니다 (${detail.status}). 실행 이력 ${detail.id}에서 확인하세요.`)
    let output = result.output
    if (result.outputJson != null) { try { output = JSON.parse(result.outputJson) } catch { output = result.outputJson } }
    return { ok: result.ok, httpStatus: result.httpStatus ?? null, output, requestText: result.requestText ?? null, responseText: result.responseText ?? null, durationMs: result.durationMs, executionId: detail.id }
  },
  // TCP 요청 전문 미리보기(전송 없음) — 편집 중 노드를 실어 미저장 편집을 실시간 반영
  tcpPreview: (flowId: string, nodeId: string, node: GraphNode) =>
    http.post<import('./types').ProtocolPreview>(`/flows/${flowId}/nodes/${nodeId}/tcp-preview`, node).then((r) => r.data),
  agentTcpPreview: (node: GraphNode, envName?: string | null) =>
    http.post<import('./types').ProtocolPreview>('/agent/tcp-preview', node, { params: { envName } }).then(r => r.data),
  inspectAgent: (node: GraphNode, envName?: string | null) =>
    http.post<import('./types').AgentInspection>('/agent/inspect', { node, workspaceId, envName }).then(r => r.data),
  recent: (limit = 50, workspaceId?: string) =>
    http.get<ExecutionSummary[]>('/executions', { params: { limit, ...(workspaceId && workspaceId !== 'public' ? { workspaceId } : {}) } }).then((r) => r.data),
  // 서버측 필터/페이지네이션 — status/flowId/기간(epoch ms)/offset
  list: (params: { limit?: number; offset?: number; status?: string; flowId?: string; from?: number; to?: number; workspaceId?: string }) =>
    http.get<ExecutionSummary[]>('/executions', { params }).then((r) => r.data),
  // 같은 조건(원본 버전+입력)으로 재실행
  rerun: (executionId: string) =>
    http.post<ExecutionDetail>(`/executions/${executionId}/rerun`, {}).then((r) => r.data),
}

const assistantApi = {
  config: () => http.get<AssistantConfig>('/assistant/config').then((r) => r.data),
  chat: (body: AssistantChatRequest) => http.post<AssistantChatResponse>('/assistant/chat', body).then((r) => r.data),
  skills: () => http.get<SkillsView>('/assistant/skills').then((r) => r.data),
  updateSkills: (body: SkillsUpdateRequest) => http.put<SkillsView>('/assistant/skills', body).then((r) => r.data),
  updateInstructions: (body: InstructionsUpdateRequest) => http.put<SkillsView>('/assistant/instructions', body).then((r) => r.data),
  // GitHub Copilot 연결(디바이스 플로우)
  oauthStatus: () => http.get<OAuthStatus>('/assistant/oauth/status').then((r) => r.data),
  oauthDeviceStart: () => http.post<DeviceStart>('/assistant/oauth/device/start', {}).then((r) => r.data),
  oauthDisconnect: () => http.post('/assistant/oauth/disconnect', {}).then(() => undefined),
  // 모델 선택 — 사용 가능한 Copilot 모델(premium 플래그) + 현재 선택
  models: () => http.get<ModelsView>('/assistant/oauth/models').then((r) => r.data),
  setModel: (model: string) => http.put<{ current: string }>('/assistant/oauth/model', { model }).then((r) => r.data),
  // VS Code 수준 종합 정보 — 계정·요금제·쿼터 사용량
  info: () => http.get<CopilotInfo>('/assistant/oauth/info').then((r) => r.data),
  // Mock 어시스턴트 — 자연어로 mock spec 생성/수정
  mockChat: (body: import('./types').MockAssistantChatRequest) =>
    http.post<import('./types').MockAssistantChatResponse>('/assistant/mock', body).then((r) => r.data),
  // 프로토콜 어시스턴트 — 명세서 표/설명 + 현재 spec → 제안 ProtocolSpec
  protocolChat: (body: import('./types').ProtocolAssistantChatRequest) =>
    http.post<import('./types').ProtocolAssistantChatResponse>('/assistant/protocol', body).then((r) => r.data),
  // 대화 세션 — 사용자별 저장·목록·이어하기
  sessions: () => http.get<SessionSummary[]>('/assistant/sessions').then((r) => r.data),
  getSession: (id: string) => http.get<SessionDetail>(`/assistant/sessions/${id}`).then((r) => r.data),
  createSession: (body: SaveSessionRequest) => http.post<SessionDetail>('/assistant/sessions', body).then((r) => r.data),
  updateSession: (id: string, body: SaveSessionRequest) => http.put<SessionDetail>(`/assistant/sessions/${id}`, body).then((r) => r.data),
  deleteSession: (id: string) => http.delete(`/assistant/sessions/${id}`).then(() => undefined),
}
  const resourceUrl = (path: string) => {
    const base = resourceBase ?? (import.meta.env.DEV ? `http://${window.location.hostname || 'localhost'}:18080` : `${window.location.origin}${appBase()}`)
    return `${base.replace(/\/+$/, '')}${path}`
  }
  const mockBaseUrl = (slug: string, _tenant?: string | null, basePath?: string) => resourceUrl(basePath ?? `/mock/ws/${encodeURIComponent(workspaceId)}/${encodeURIComponent(slug)}`)
  return { flowsApi, triggersApi, secretsApi, suitesApi, transformsApi, pluginsApi, foldersApi, workspacesApi, adminApi, mocksApi, protocolsApi, codecsApi, environmentsApi, runInputApi, settingsApi, runsApi, assistantApi, mockBaseUrl, resourceUrl }
}
export type WorkspaceApi = ReturnType<typeof createApi>
