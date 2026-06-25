// 백엔드(com.flowlink.*) DTO/그래프 모델과 1:1 대응하는 공유 타입.
// (enum 대신 문자열 유니온 — tsconfig erasableSyntaxOnly 준수)

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
export type NodeType = 'start' | 'end' | 'set' | 'http' | 'if' | 'wait'
export type BodyType = 'json' | 'urlencoded' | 'form' | 'raw' | 'xml'
export type RespType = 'json' | 'text' | 'xml' | 'binary'
export type ReqMode = 'server' | 'client'

export interface Binding {
  nodeName?: string
  cat?: string
  key: string
  sourceId: string
  scope?: 'req' | null
}

export interface NodeField {
  id: string
  key: string
  value?: string | null
  bound?: Binding | null
}

export interface NodeFields {
  params?: NodeField[]
  headers?: NodeField[]
  body?: NodeField[]
}

export interface NodeVar {
  id: string
  key: string
  value?: string | null
  secret?: boolean
  bound?: Binding | null
}

export interface WaitField {
  id: string
  key: string
  label?: string
}

export interface NodeOutput {
  key: string
  type?: string
}

export interface GraphNode {
  id: string
  name?: string
  type: NodeType
  cat?: string
  // http
  method?: HttpMethod
  baseUrl?: string
  baseUrlBound?: Binding | null
  path?: string
  bodyType?: BodyType
  respType?: RespType
  rawBody?: string
  jsonRaw?: boolean
  reqMode?: ReqMode
  fields?: NodeFields
  outputs?: NodeOutput[]
  // set
  vars?: NodeVar[]
  // if
  condition?: string
  // wait
  waitMsg?: string
  waitFields?: WaitField[]
  // canvas
  x?: number
  y?: number
}

export interface GraphEdge {
  id: string
  from: string
  fromPort?: string
  to: string
}

export interface FlowGraph {
  version?: number
  name?: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// --- 정의 DTO ---
export interface FlowSummary {
  id: string
  name: string
  description?: string | null
  currentVersion: number
  updatedAt: string
}

export interface FlowVersionSummary {
  id: string
  versionNo: number
  name: string
  note?: string | null
  createdBy?: string | null
  createdAt: string
}

export interface FlowDetail {
  id: string
  name: string
  description?: string | null
  currentVersion: number
  createdAt: string | null
  updatedAt: string | null
  graph: FlowGraph
}

export interface CreateFlowRequest {
  name: string
  description?: string
}

export interface UpdateFlowRequest {
  name?: string
  description?: string
}

export interface SaveVersionRequest {
  graph: FlowGraph
  note?: string
}

// --- 실행 DTO ---
export type ExecutionStatus =
  | 'PENDING' | 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
export type NodeExecutionStatus =
  | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'WAITING' | 'SKIPPED'
export type TriggerType = 'MANUAL' | 'SCHEDULE' | 'WEBHOOK' | 'EVENT'

export interface RunRequest {
  input?: Record<string, unknown>
  versionNo?: number
}

export interface ExecutionSummary {
  id: string
  flowId: string
  status: ExecutionStatus
  trigger: TriggerType
  startedAt: string | null
  finishedAt: string | null
}

export interface NodeExecutionView {
  id: string
  nodeId: string
  nodeName?: string
  nodeType?: string
  seq: number
  status: NodeExecutionStatus
  httpStatus?: number | null
  durationMs?: number | null
  ok: boolean
  requestText?: string | null
  responseText?: string | null
  output?: unknown
}

export interface ExecutionDetail {
  id: string
  flowId: string
  flowVersionId: string
  status: ExecutionStatus
  trigger: TriggerType
  triggeredBy?: string | null
  startedAt: string | null
  finishedAt: string | null
  error?: string | null
  nodes: NodeExecutionView[]
}

export interface ApiError {
  timestamp: string
  status: number
  error: string
  message: string
  path: string
  details: string[]
}
