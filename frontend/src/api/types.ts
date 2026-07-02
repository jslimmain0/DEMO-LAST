// 백엔드(com.flowlink.*) DTO/그래프 모델과 1:1 대응하는 공유 타입.
// (enum 대신 문자열 유니온 — tsconfig erasableSyntaxOnly 준수)

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
export type NodeType = 'start' | 'end' | 'set' | 'http' | 'if' | 'wait' | 'transform' | 'tcp'
export type BodyType = 'json' | 'urlencoded' | 'form' | 'raw' | 'xml'
export type RespType = 'json' | 'xml' | 'urlencoded' | 'form' | 'text' | 'binary'
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
  // JSON 바디 값의 타입(따옴표 여부). 'string'/미지정=기존 동작(문자열/네이티브), number/boolean/json=코어션.
  type?: string
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
  // Params(쿼리)·Headers 의 [필드 ↔ Raw] 전환 — body 의 jsonRaw/rawBody 와 동일 패턴
  paramsRaw?: boolean
  rawParams?: string   // paramsRaw=true 일 때 쿼리스트링 원문(a=1&b=2)
  headersRaw?: boolean
  rawHeaders?: string  // headersRaw=true 일 때 헤더 원문(Key: Value 줄바꿈)
  reqMode?: ReqMode
  charset?: string // 요청 인코딩·응답 디코딩 문자셋(UTF-8 기본 · EUC-KR/MS949/US-ASCII)
  fields?: NodeFields
  outputs?: NodeOutput[]
  // set
  vars?: NodeVar[]
  // if
  condition?: string
  // wait / 폼 전송(팝업)
  waitMsg?: string
  waitFields?: WaitField[]
  formAction?: string   // 폼을 target 전송할 URL
  formMethod?: string   // POST | GET
  // transform
  transformId?: string
  config?: Record<string, string>
  // tcp (고정길이 금융 전문)
  tcpHost?: string
  tcpPort?: number
  tcpEncoding?: string
  tcpTimeoutMs?: number
  tcpPrefixLength?: number
  tcpPrefixIncludesSelf?: boolean
  tcpRequest?: TcpField[]
  tcpResponse?: TcpRespField[]
  // canvas
  x?: number
  y?: number
}

export interface TcpField {
  id: string
  name?: string
  length?: number
  value?: string | null
  bound?: Binding | null
  pad?: 'left' | 'right'
  padChar?: string
  encoding?: string
}

export interface TcpRespField {
  id: string
  name?: string
  length?: number
  encoding?: string
}

export interface TransformParam {
  key: string
  label: string
  type: string
  defaultValue: string
}

export interface TransformIo {
  key: string
  label: string
  type: string
}

export interface TransformInfo {
  id: string
  label: string
  inputs: TransformIo[]
  outputs: TransformIo[]
  params: TransformParam[]
}

export interface GraphEdge {
  id: string
  from: string
  fromPort?: string
  to: string
}

// 가져온(OpenAPI/Swagger) 오퍼레이션을 왼쪽 팔레트에 묶어두는 그룹.
// 실행 그래프(nodes/edges)와 무관한 "재사용 템플릿"이며 FlowGraph 에 함께 저장된다.
export interface PaletteItem {
  id: string
  label: string
  method?: HttpMethod
  path?: string
  node: GraphNode // 캔버스에 떨어뜨릴 때 새 id 로 복제되는 노드 템플릿
}

export interface PaletteGroup {
  id: string
  title: string
  items: PaletteItem[]
}

export interface FlowGraph {
  version?: number
  name?: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  palette?: PaletteGroup[]
}

// --- 정의 DTO ---
export interface FlowSummary {
  id: string
  name: string
  description?: string | null
  currentVersion: number
  folderId?: string | null
  updatedAt: string
}

export interface FolderSummary {
  id: string
  name: string
  flowCount: number
  createdAt: string
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
  folderId?: string | null
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

// client(클라이언트→서버) 모드 노드에서 실행이 중단될 때, 브라우저가 대신 호출할 요청.
export interface PendingClientRequest {
  nodeId: string
  nodeName?: string
  method: string
  url: string
  headers: Record<string, string>
  body?: string | null
  respType?: string
}

// 폼 전송 노드에서 중단될 때, 브라우저가 새 창(팝업)으로 target 전송할 폼 명세(값 해석 완료).
export interface PendingFormRequest {
  nodeId: string
  nodeName?: string
  action: string
  method: string
  fields: Array<{ key: string; value?: string | null }>
}

// 실행 재개 바디. client HTTP 는 status/body/error 를, WAIT(폼)은 formValues 를 채운다.
export interface ResumeRequest {
  nodeId?: string
  status?: number
  body?: string | null
  error?: string | null
  formValues?: Record<string, unknown>
  durationMs?: number
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
  pendingClient?: PendingClientRequest | null
  pendingForm?: PendingFormRequest | null
}

export interface ApiError {
  timestamp: string
  status: number
  error: string
  message: string
  path: string
  details: string[]
}
