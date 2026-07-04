// 백엔드(com.flowlink.*) DTO/그래프 모델과 1:1 대응하는 공유 타입.
// (enum 대신 문자열 유니온 — tsconfig erasableSyntaxOnly 준수)

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
export type NodeType = 'start' | 'end' | 'set' | 'http' | 'if' | 'assert' | 'form' | 'wait' | 'input' | 'transform' | 'tcp'
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
  // 값 해석 타입(string 기본 · number · boolean · json) — confirm 시점에 브라우저가 파싱해 보낸다
  type?: string
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
  // if · assert(검증 — 거짓이면 실행 실패)
  condition?: string
  // form (폼 전송 · 팝업/iframe)
  formAction?: string        // 열어서 form 을 제출할 URL
  formMethod?: string        // POST | GET
  formDisplay?: 'popup' | 'iframe'  // 표시 방식: 팝업 창(기본) or 페이지 내 iframe 모달
  // wait (콜백/노티 수신 대기)
  waitTimeoutSec?: number      // 콜백 대기 타임아웃(초, 기본 120)
  callbackRespType?: string    // 콜백에 줄 응답 형식: text | html | json
  callbackRespBody?: string    // 콜백에 줄 응답 본문(relay 에 사전 등록)
  // input (사용자 입력 대기 — 모달 input box)
  waitMsg?: string           // 모달 안내 메시지
  waitFields?: WaitField[]   // 입력 필드 정의(key/label/type)
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
  // wait(콜백 대기) 노드용 — 브라우저가 실행 직전 만든 relay 실행ID(영숫자 16자)와 relay 주소.
  // 서버가 {relayBase}/cb/{relayRunId}/{노드ID} 수신 URL 을 조립해 {{ url@노드ID }} 로 노출한다.
  relayRunId?: string
  relayBase?: string
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

// form(팝업) 노드에서 중단될 때, 브라우저가 팝업으로 제출할 폼 명세(값 해석 완료).
export interface PendingFormRequest {
  nodeId: string
  nodeName?: string
  action: string
  method: string
  fields: Array<{ key: string; value?: string | null }>
}

// wait(콜백 대기) 노드에서 중단될 때 넘어오는 대기 명세. receiveUrl 은 relay 미연동이면 null.
export interface PendingWaitRequest {
  nodeId: string
  nodeName?: string
  timeoutSec: number
  receiveUrl?: string | null
}

// input(사용자 입력) 노드에서 중단될 때 넘어오는 모달 입력 명세.
// confirm 값은 ResumeRequest.formValues 로 돌아가 노드 출력이 된다.
export interface PendingInputRequest {
  nodeId: string
  nodeName?: string
  message?: string
  fields: Array<{ key: string; label?: string | null; type?: string | null }>
}

// relay 가 수신해 SSE 로 전달한 콜백 전문 — wait 재개 페이로드.
export interface CallbackPayload {
  method: string
  url?: string
  headers?: Record<string, string>
  body?: string
}

// 실행 재개 바디. client HTTP 는 status/body/error 를, form 은 popupOpened/error 를,
// wait 는 callback(수신) 또는 error(타임아웃/중단, aborted=사용자 중단)를 채운다.
export interface ResumeRequest {
  nodeId?: string
  status?: number
  body?: string | null
  error?: string | null
  formValues?: Record<string, unknown>
  popupOpened?: boolean
  callback?: CallbackPayload
  aborted?: boolean
  durationMs?: number
}

export interface ExecutionSummary {
  id: string
  flowId: string
  flowName?: string | null
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
  pendingWait?: PendingWaitRequest | null
  pendingInput?: PendingInputRequest | null
}

// --- Mock 서버 (내장 mock 기능 — /mock/{slug}/** 로 서빙) ---

export interface MockCond {
  source: 'query' | 'header' | 'body' | 'path'
  key: string
  op: 'eq' | 'ne' | 'exists' | 'contains'
  value?: string
}

// 응답 후 웹훅 발사(승인노티/입금노티 패턴). url 이 비면 미발사.
export interface MockCallbackSpec {
  afterMs?: number
  url?: string
  method?: string
  contentType?: string
  body?: string
  retryUntilOk?: boolean
}

export interface MockRuleSpec {
  id: string
  when?: MockCond[] // 모두 만족(AND). 없으면 항상 매칭(기본 규칙)
  status?: number
  contentType?: string // json|text|html|xml|urlencoded 또는 mime
  charset?: string     // UTF-8(기본)|EUC-KR|MS949
  headers?: Array<{ key: string; value: string }>
  body?: string        // 템플릿: {{path.x}} {{query.x}} {{body.x}} {{header.x}} {{uuid}} {{seq}} {{now}}
  delayMs?: number
  callback?: MockCallbackSpec | null
}

export interface MockRouteSpec {
  id: string
  method: string // GET/POST/…/ANY
  path: string   // /users/{id}
  rules: MockRuleSpec[]
}

export interface MockServerSpec {
  routes?: MockRouteSpec[]
}

export type MockKind = 'CUSTOM'

export interface MockServerSummary {
  id: string
  name: string
  slug: string
  kind: MockKind
  enabled: boolean
  updatedAt: string | null
}

export interface MockServerDetail extends MockServerSummary {
  spec: MockServerSpec
  createdAt: string | null
}

