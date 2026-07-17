import axios from 'axios'
import type {
  CreateFlowRequest,
  ExecutionDetail,
  ExecutionSummary,
  FlowDetail,
  FlowSummary,
  FlowVersionSummary,
  FolderSummary,
  ResumeRequest,
  RunRequest,
  SaveVersionRequest,
  SingleNodeRunResult,
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
  list: () => http.get<FlowSummary[]>('/flows').then((r) => r.data),
  get: (id: string) => http.get<FlowDetail>(`/flows/${id}`).then((r) => r.data),
  create: (body: CreateFlowRequest) => http.post<FlowDetail>('/flows', body).then((r) => r.data),
  remove: (id: string) => http.delete(`/flows/${id}`).then(() => undefined),
  saveVersion: (id: string, body: SaveVersionRequest) =>
    http.post<FlowVersionSummary>(`/flows/${id}/versions`, body).then((r) => r.data),
  importFlow: (graph: unknown) =>
    http.post<FlowDetail>('/flows/import', graph).then((r) => r.data),
  move: (id: string, folderId: string | null) =>
    http.put(`/flows/${id}/folder`, { folderId }).then(() => undefined),
}

export const transformsApi = {
  list: () => http.get<import('./types').TransformInfo[]>('/transforms').then((r) => r.data),
}

export const pluginsApi = {
  upload: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return uploadHttp.post<string[]>('/plugins', fd).then((r) => r.data)
  },
}

export const foldersApi = {
  list: () => http.get<FolderSummary[]>('/folders').then((r) => r.data),
  create: (name: string, parentId: string | null = null) =>
    http.post<FolderSummary>('/folders', { name, parentId }).then((r) => r.data),
  // 폴더 재배치(드래그 이동) — parentId=null 은 루트로. 자기/하위 아래로는 400.
  move: (id: string, parentId: string | null) =>
    http.put<FolderSummary>(`/folders/${id}/parent`, { parentId }).then((r) => r.data),
  rename: (id: string, name: string) => http.patch<FolderSummary>(`/folders/${id}`, { name }).then((r) => r.data),
  remove: (id: string) => http.delete(`/folders/${id}`).then(() => undefined),
}

export const mocksApi = {
  list: () => http.get<import('./types').MockServerSummary[]>('/mock-servers').then((r) => r.data),
  get: (id: string) => http.get<import('./types').MockServerDetail>(`/mock-servers/${id}`).then((r) => r.data),
  create: (body: { name: string; slug: string }) =>
    http.post<import('./types').MockServerDetail>('/mock-servers', body).then((r) => r.data),
  update: (id: string, body: { name?: string; enabled?: boolean }) =>
    http.patch<import('./types').MockServerDetail>(`/mock-servers/${id}`, body).then((r) => r.data),
  updateSpec: (id: string, spec: import('./types').MockServerSpec) =>
    http.put<import('./types').MockServerDetail>(`/mock-servers/${id}/spec`, { spec }).then((r) => r.data),
  remove: (id: string) => http.delete(`/mock-servers/${id}`).then(() => undefined),
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
  // 단일 노드 독립 실행 — 그 노드만 새 컨텍스트로 즉석 실행(이력 미저장, 상류 바인딩 null)
  runNode: (flowId: string, nodeId: string) =>
    http.post<SingleNodeRunResult>(`/flows/${flowId}/nodes/${nodeId}/run`, {}).then((r) => r.data),
  recent: (limit = 50) =>
    http.get<ExecutionSummary[]>('/executions', { params: { limit } }).then((r) => r.data),
}
