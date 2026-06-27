import axios from 'axios'
import type {
  CreateFlowRequest,
  ExecutionDetail,
  ExecutionSummary,
  FlowDetail,
  FlowGraph,
  FlowSummary,
  FlowVersionSummary,
  FolderSummary,
  RunRequest,
  SaveVersionRequest,
  UpdateFlowRequest,
} from './types'

// Vite 프록시(/api → 18080) 기준 동일 오리진 호출. (운영 절대경로 주입은 후속)
export const http = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

// 멀티파트(파일 업로드)용 — 기본 JSON 헤더 없이 axios가 boundary 를 설정하게 둔다.
const uploadHttp = axios.create({ baseURL: '/api/v1' })

export const flowsApi = {
  list: () => http.get<FlowSummary[]>('/flows').then((r) => r.data),
  get: (id: string) => http.get<FlowDetail>(`/flows/${id}`).then((r) => r.data),
  create: (body: CreateFlowRequest) => http.post<FlowDetail>('/flows', body).then((r) => r.data),
  update: (id: string, body: UpdateFlowRequest) =>
    http.patch<FlowDetail>(`/flows/${id}`, body).then((r) => r.data),
  remove: (id: string) => http.delete(`/flows/${id}`).then(() => undefined),
  saveVersion: (id: string, body: SaveVersionRequest) =>
    http.post<FlowVersionSummary>(`/flows/${id}/versions`, body).then((r) => r.data),
  versions: (id: string) =>
    http.get<FlowVersionSummary[]>(`/flows/${id}/versions`).then((r) => r.data),
  versionGraph: (id: string, no: number) =>
    http.get<FlowGraph>(`/flows/${id}/versions/${no}`).then((r) => r.data),
  importFlow: (graph: unknown) =>
    http.post<FlowDetail>('/flows/import', graph).then((r) => r.data),
  exportUrl: (id: string) => `/api/v1/flows/${id}/export`,
  move: (id: string, folderId: string | null) =>
    http.put(`/flows/${id}/folder`, { folderId }).then(() => undefined),
}

export const transformsApi = {
  list: () => http.get<import('./types').TransformInfo[]>('/transforms').then((r) => r.data),
}

export const pluginsApi = {
  list: () => http.get<string[]>('/plugins').then((r) => r.data),
  upload: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return uploadHttp.post<string[]>('/plugins', fd).then((r) => r.data)
  },
}

export const foldersApi = {
  list: () => http.get<FolderSummary[]>('/folders').then((r) => r.data),
  create: (name: string) => http.post<FolderSummary>('/folders', { name }).then((r) => r.data),
  rename: (id: string, name: string) => http.patch<FolderSummary>(`/folders/${id}`, { name }).then((r) => r.data),
  remove: (id: string) => http.delete(`/folders/${id}`).then(() => undefined),
}

export const runsApi = {
  run: (flowId: string, body?: RunRequest) =>
    http.post<ExecutionDetail>(`/flows/${flowId}/runs`, body ?? {}).then((r) => r.data),
  listForFlow: (flowId: string, limit = 50) =>
    http.get<ExecutionSummary[]>(`/flows/${flowId}/runs`, { params: { limit } }).then((r) => r.data),
  get: (id: string) => http.get<ExecutionDetail>(`/executions/${id}`).then((r) => r.data),
  recent: (limit = 50) =>
    http.get<ExecutionSummary[]>('/executions', { params: { limit } }).then((r) => r.data),
}
