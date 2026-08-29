import axios from 'axios'
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
  TcpPreview,
} from './types'

// Vite 프록시(/api → 18080) 기준 동일 오리진 호출. (운영 절대경로 주입은 후속)
export const http = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

// 멀티파트(파일 업로드)용 — 기본 JSON 헤더 없이 axios가 boundary 를 설정하게 둔다.
// (auth 모듈이 두 인스턴스 모두에 Bearer 인터셉터를 부착한다)
export const uploadHttp = axios.create({ baseURL: '/api/v1' })

export const flowsApi = {
  list: (workspaceId?: string) =>
    http.get<FlowSummary[]>('/flows', { params: workspaceId && workspaceId !== 'public' ? { workspaceId } : undefined }).then((r) => r.data),
  get: (id: string) => http.get<FlowDetail>(`/flows/${id}`).then((r) => r.data),
  create: (body: CreateFlowRequest) => http.post<FlowDetail>('/flows', body).then((r) => r.data),
  remove: (id: string) => http.delete(`/flows/${id}`).then(() => undefined),
  saveVersion: (id: string, body: SaveVersionRequest) =>
    http.post<FlowVersionSummary>(`/flows/${id}/versions`, body).then((r) => r.data),
  listVersions: (id: string) =>
    http.get<FlowVersionSummary[]>(`/flows/${id}/versions`).then((r) => r.data),
  getVersion: (id: string, no: number) =>
    http.get<FlowGraph>(`/flows/${id}/versions/${no}`).then((r) => r.data),
  restoreVersion: (id: string, no: number) =>
    http.post<FlowVersionSummary>(`/flows/${id}/versions/${no}/restore`).then((r) => r.data),
  importFlow: (graph: unknown) =>
    http.post<FlowDetail>('/flows/import', graph).then((r) => r.data),
  move: (id: string, folderId: string | null) =>
    http.put(`/flows/${id}/folder`, { folderId }).then(() => undefined),
  updateMeta: (id: string, body: { name?: string; description?: string }) =>
    http.patch<FlowDetail>(`/flows/${id}`, body).then((r) => r.data),
}

export const triggersApi = {
  list: (flowId: string) =>
    http.get<import('./types').TriggerView[]>(`/flows/${flowId}/triggers`).then((r) => r.data),
  create: (flowId: string, body: import('./types').CreateTriggerRequest) =>
    http.post<import('./types').TriggerView>(`/flows/${flowId}/triggers`, body).then((r) => r.data),
  update: (flowId: string, id: string, body: { enabled?: boolean; cron?: string; versionNo?: number; input?: Record<string, unknown> }) =>
    http.put<import('./types').TriggerView>(`/flows/${flowId}/triggers/${id}`, body).then((r) => r.data),
  remove: (flowId: string, id: string) =>
    http.delete(`/flows/${flowId}/triggers/${id}`).then(() => undefined),
}

// environment: null=공통(전역), 그 외=해당 환경 전용. source: 'db'(편집 가능) | 'vault'(Vault 에서 끌어옴, 읽기전용)
export interface SecretView { name: string; environment: string | null; createdAt: string | null; source?: 'db' | 'vault' }
export const secretsApi = {
  list: () => http.get<SecretView[]>('/secrets').then((r) => r.data),
  put: (name: string, value: string, environment?: string | null) =>
    http.put<SecretView>(`/secrets/${encodeURIComponent(name)}`, { value, environment: environment || null }).then((r) => r.data),
  remove: (name: string, environment?: string | null) =>
    http.delete(`/secrets/${encodeURIComponent(name)}`, { params: environment ? { environment } : undefined }).then(() => undefined),
}

export interface SuiteRunItem { flowId: string; flowName: string; executionId: string | null; status: string; error: string | null }
export const suitesApi = {
  run: (body: { flowIds?: string[]; folderId?: string }) =>
    http.post<SuiteRunItem[]>('/suites/run', body).then((r) => r.data),
}

export const transformsApi = {
  list: () => http.get<import('./types').TransformInfo[]>('/transforms').then((r) => r.data),
  // 미리보기 — 샘플 입력/설정으로 변환 결과를 즉시 확인(순수 계산)
  preview: (id: string, body: { inputs: Record<string, string>; config: Record<string, string> }) =>
    http.post<import('./types').TransformPreviewResponse>(`/transforms/${id}/preview`, body).then((r) => r.data),
}

export const pluginsApi = {
  upload: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return uploadHttp.post<string[]>('/plugins', fd).then((r) => r.data)
  },
}

export const foldersApi = {
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

// ── 워크스페이스(폴더 위 최상위 그룹) + 롤 ──────────────────────────────
export interface WorkspaceView { id: string; name: string; kind: 'PUBLIC' | 'PERSONAL' | 'TEAM'; myRole: 'OWNER' | 'EDITOR' | 'VIEWER'; canManage: boolean }
export interface WorkspaceMemberView { username: string; role: 'OWNER' | 'EDITOR' | 'VIEWER' }
export const workspacesApi = {
  list: () => http.get<WorkspaceView[]>('/workspaces').then((r) => r.data),
  create: (name: string) => http.post<WorkspaceView>('/workspaces', { name }).then((r) => r.data),
  remove: (id: string) => http.delete(`/workspaces/${id}`).then(() => undefined),
  members: (id: string) => http.get<WorkspaceMemberView[]>(`/workspaces/${id}/members`).then((r) => r.data),
  putMember: (id: string, username: string, role: string) =>
    http.put<WorkspaceMemberView[]>(`/workspaces/${id}/members`, { username, role }).then((r) => r.data),
  removeMember: (id: string, username: string) =>
    http.delete<WorkspaceMemberView[]>(`/workspaces/${id}/members/${encodeURIComponent(username)}`).then((r) => r.data),
}

export interface AdminMeView { username: string; admin: boolean; authenticated: boolean; pendingCount: number }
export type UserStatus = 'PENDING' | 'APPROVED' | 'BLOCKED'
export interface AdminUserView { username: string; globalRole: 'ADMIN' | 'MEMBER'; status: UserStatus; lastSeenAt: string | null; createdAt: string | null }
export interface AdminWorkspaceView {
  id: string; name: string; kind: 'PERSONAL' | 'TEAM'; ownerUsername: string | null
  createdAt: string | null; flowCount: number; members: WorkspaceMemberView[]
}
export interface AdminWorkspacesResponse { publicFlowCount: number; workspaces: AdminWorkspaceView[] }
export const adminApi = {
  me: () => http.get<AdminMeView>('/admin/me').then((r) => r.data),
  users: () => http.get<AdminUserView[]>('/admin/users').then((r) => r.data),
  putUser: (username: string, body: { globalRole?: string; status?: string }) =>
    http.put<AdminUserView>(`/admin/users/${encodeURIComponent(username)}`, body).then((r) => r.data),
  removeUser: (username: string) =>
    http.delete(`/admin/users/${encodeURIComponent(username)}`).then(() => undefined),
  // 팀·권한 콘솔 — 전체 워크스페이스(팀+개인) + 멤버 + 워크플로 수 1왕복
  workspaces: () => http.get<AdminWorkspacesResponse>('/admin/workspaces').then((r) => r.data),
}

export const mocksApi = {
  list: () => http.get<import('./types').MockServerSummary[]>('/mock-servers').then((r) => r.data),
  get: (id: string) => http.get<import('./types').MockServerDetail>(`/mock-servers/${id}`).then((r) => r.data),
  create: (body: { name: string; slug: string; type?: 'HTTP' | 'TCP' }) =>
    http.post<import('./types').MockServerDetail>('/mock-servers', body).then((r) => r.data),
  update: (id: string, body: { name?: string; enabled?: boolean }) =>
    http.patch<import('./types').MockServerDetail>(`/mock-servers/${id}`, body).then((r) => r.data),
  updateSpec: (id: string, spec: import('./types').MockServerSpec) =>
    http.put<import('./types').MockServerDetail>(`/mock-servers/${id}/spec`, { spec }).then((r) => r.data),
  remove: (id: string) => http.delete(`/mock-servers/${id}`).then(() => undefined),
  requests: (id: string) => http.get<import('./types').MockRequestLog[]>(`/mock-servers/${id}/requests`).then((r) => r.data),
  clearRequests: (id: string) => http.delete(`/mock-servers/${id}/requests`).then(() => undefined),
  reset: (id: string) => http.post(`/mock-servers/${id}/reset`).then(() => undefined),
  state: (id: string) => http.get<import('./types').MockStateView>(`/mock-servers/${id}/state`).then((r) => r.data),
}

/**
 * mock 서빙 base URL.
 * - 프로덕션(단일 jar): 게이트웨이가 화면과 같은 오리진(내장 톰캣)이므로 현재 오리진 그대로 —
 *   포트를 바꾸거나 프록시/https 뒤에 둬도 복사 URL 이 실제 주소를 따라간다.
 * - dev(Vite 5173): /mock 프록시가 없으니 백엔드(18080) 직행 고정.
 */
export function mockBaseUrl(slug: string, tenant?: string | null): string {
  // 팀(테넌트) 스코프 slug — default 팀은 레거시 /mock/{slug} 그대로(demos·기존 그래프 호환),
  // 그 외 팀은 /mock/{tenant}/{slug} (팀끼리 같은 slug 를 써도 충돌하지 않는다)
  const seg = tenant && tenant !== 'default' ? `${tenant}/${slug}` : slug
  if (import.meta.env.DEV) {
    const host = window.location.hostname || 'localhost'
    return `http://${host}:18080/mock/${seg}`
  }
  return `${window.location.origin}/mock/${seg}`
}

/** 런타임 설정 — 콜백 수신 주소(relay base). value=저장된 오버라이드(null=자동), effective=실제 적용값, auto=접속 주소 자동값 */
export interface RelaySetting {
  value: string | null
  effective: string
  auto: string | null
}
export const settingsApi = {
  relay: () => http.get<RelaySetting>('/settings/relay').then((r) => r.data),
  saveRelay: (value: string | null) => http.put<RelaySetting>('/settings/relay', { value }).then((r) => r.data),
  notify: () => http.get<{ value: string | null }>('/settings/notify').then((r) => r.data),
  saveNotify: (value: string | null) => http.put<{ value: string | null }>('/settings/notify', { value }).then((r) => r.data),
}

export const runsApi = {
  run: (flowId: string, body?: RunRequest) =>
    http.post<ExecutionDetail>(`/flows/${flowId}/runs`, body ?? {}).then((r) => r.data),
  get: (executionId: string) =>
    http.get<ExecutionDetail>(`/executions/${executionId}`).then((r) => r.data),
  // 실행 경과 애니메이션용 — 방금 시작된 실행의 id 를 찾기 위해 이 플로우의 최근 실행을 조회
  listForFlow: (flowId: string, limit = 1) =>
    http.get<ExecutionSummary[]>(`/flows/${flowId}/runs`, { params: { limit } }).then((r) => r.data),
  resume: (executionId: string, body: ResumeRequest) =>
    http.post<ExecutionDetail>(`/executions/${executionId}/resume`, body).then((r) => r.data),
  // 단일 노드 독립 실행 — 그 노드만 즉석 실행(이력 미저장). body 로 env/envName/input 을 실어 {{키@env}}·{{이름@secret}} 해석,
  // upstream({소스노드:{키:값}})으로 이전 노드 값을 수동 주입
  runNode: (flowId: string, nodeId: string, body?: { env?: Record<string, string>; envName?: string | null; input?: unknown; upstream?: Record<string, Record<string, unknown>> }) =>
    http.post<SingleNodeRunResult>(`/flows/${flowId}/nodes/${nodeId}/run`, body ?? {}).then((r) => r.data),
  // TCP 요청 전문 미리보기(전송 없음) — 편집 중 노드를 실어 미저장 편집을 실시간 반영
  tcpPreview: (flowId: string, nodeId: string, node: GraphNode) =>
    http.post<TcpPreview>(`/flows/${flowId}/nodes/${nodeId}/tcp-preview`, node).then((r) => r.data),
  recent: (limit = 50) =>
    http.get<ExecutionSummary[]>('/executions', { params: { limit } }).then((r) => r.data),
  // 서버측 필터/페이지네이션 — status/flowId/기간(epoch ms)/offset
  list: (params: { limit?: number; offset?: number; status?: string; flowId?: string; from?: number; to?: number; workspaceId?: string }) =>
    http.get<ExecutionSummary[]>('/executions', { params }).then((r) => r.data),
  // 같은 조건(원본 버전+입력)으로 재실행
  rerun: (executionId: string) =>
    http.post<ExecutionDetail>(`/executions/${executionId}/rerun`, {}).then((r) => r.data),
}

// AI 어시스턴트 — 자연어로 플로우 생성/수정
export const assistantApi = {
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
  // 대화 세션 — 사용자별 저장·목록·이어하기
  sessions: () => http.get<SessionSummary[]>('/assistant/sessions').then((r) => r.data),
  getSession: (id: string) => http.get<SessionDetail>(`/assistant/sessions/${id}`).then((r) => r.data),
  createSession: (body: SaveSessionRequest) => http.post<SessionDetail>('/assistant/sessions', body).then((r) => r.data),
  updateSession: (id: string, body: SaveSessionRequest) => http.put<SessionDetail>(`/assistant/sessions/${id}`, body).then((r) => r.data),
  deleteSession: (id: string) => http.delete(`/assistant/sessions/${id}`).then(() => undefined),
}
