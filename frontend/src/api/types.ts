// 백엔드(com.flowlink.*) DTO/그래프 모델과 1:1 대응하는 공유 타입.
// (enum 대신 문자열 유니온 — tsconfig erasableSyntaxOnly 준수)

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
export type NodeType = 'start' | 'end' | 'set' | 'http' | 'if' | 'assert' | 'switch' | 'form' | 'wait' | 'input' | 'transform' | 'tcp' | 'note' | 'group'
export type BodyType = 'json' | 'urlencoded' | 'form' | 'raw' | 'xml'
export type RespType = 'json' | 'xml' | 'urlencoded' | 'form' | 'query' | 'text' | 'binary'
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
  // switch (경로 스위치 — 선로 전환기. 조건 없이 젖혀둔 트랙으로만 흐른다)
  switchPorts?: SwitchPort[]  // 트랙 목록(id=엣지 fromPort, label=표시명)
  switchActive?: string       // 젖혀둔 트랙 id
  // form (폼 전송 · 팝업/iframe)
  formAction?: string        // 열어서 form 을 제출할 URL
  formMethod?: string        // POST | GET
  formDisplay?: 'popup' | 'iframe'  // 표시 방식: 팝업 창(기본) or 페이지 내 iframe 모달
  // wait (콜백/노티 수신 대기)
  waitTimeoutSec?: number      // 콜백 대기 타임아웃(초, 기본 120)
  callbackRespType?: string    // 콜백에 줄 응답 형식: text | html | json
  callbackRespBody?: string    // 콜백에 줄 응답 본문(백엔드가 콜백 수신 시 돌려줌)
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
  // note · group (캔버스 주석 — 실행 제외. 백엔드는 raw 저장이라 스키마 변경 없음)
  noteText?: string   // 메모 본문
  noteColor?: string  // 주석 색(yellow/blue/pink/green/gray — nodeMeta.ANNO_COLORS)
  groupW?: number     // 영역 박스 폭(px, 그리드 22 배수)
  groupH?: number     // 영역 박스 높이(px)
  // canvas
  collapsed?: boolean // 노드 접기(헤더만 표시 — 상세행/부라벨 숨김). raw 라운드트립, 실행 무관
  x?: number
  y?: number
}

export interface SwitchPort {
  id: string
  label?: string
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
  type: string // string | number | select | textarea
  defaultValue: string
  options?: string[]     // select 일 때 선택지
  placeholder?: string
}

export interface TransformIo {
  key: string
  label: string
  type: string // string | number | boolean | json | array
  example?: string
}

export interface TransformInfo {
  id: string
  label: string
  description?: string
  inputs: TransformIo[]
  outputs: TransformIo[]
  params: TransformParam[]
}

export interface TransformPreviewResponse { ok: boolean; outputs: Record<string, unknown>; error?: string }

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

// --- AI 어시스턴트(자연어 → 플로우) ---
export interface AssistantMessage { role: 'user' | 'assistant'; content: string }
export interface AssistantChatRequest { messages: AssistantMessage[]; graph?: FlowGraph | null; model?: string }
export interface AssistantChatResponse { reply: string; graph: FlowGraph | null; stub: boolean; model: string }
export interface AssistantConfig { available: boolean; usingRealLlm: boolean; model: string; authMode: 'oauth' | 'key' | 'stub' }
// AI 어시스턴트 GitHub Copilot 연결(디바이스 플로우 — 확장과 동일)
export interface OAuthStatus { connected: boolean; pending: boolean; error: string | null }
export interface DeviceStart { userCode: string; verificationUri: string; expiresIn: number; intervalSec: number }
// Copilot 모델 선택 — premium=프리미엄 요청 쿼터 필요(계정에 없으면 429)
export interface CopilotModel { id: string; name: string; premium: boolean; recommended?: boolean; vendor?: string; contextTokens?: number; vision?: boolean; preview?: boolean }
export interface ModelsView { models: CopilotModel[]; current: string }
// VS Code 확장 수준 종합 정보 — 계정·요금제·쿼터 사용량
export interface CopilotQuota { id: string; label: string; unlimited: boolean; percentRemaining: number; remaining: number; entitlement: number; used: number; overagePermitted: boolean }
export interface CopilotInfo {
  connected: boolean
  login: string | null
  avatarUrl: string | null
  plan: string | null
  sku: string | null
  chatEnabled: boolean
  agentEnabled: boolean
  quotaResetDate: string | null
  quotas: CopilotQuota[]
  currentModel: string
  tokenExpiresAt: number | null
  error?: string | null
}
// AI 어시스턴트 대화 세션(사용자별 저장·이어하기)
export interface SavedTurn { role: 'user' | 'assistant'; content: string; graph?: FlowGraph | null; stub?: boolean }
export interface SessionSummary { id: string; title: string; updatedAt: string; messageCount: number }
export interface SessionDetail { id: string; title: string; messages: SavedTurn[]; updatedAt: string }
export interface SaveSessionRequest { title?: string; messages: SavedTurn[] }
// 스킬 = 재사용 프롬프트(awesome-copilot 스타일). 클릭해 어시스턴트에 적용.
export interface Skill { id?: string; name: string; description?: string; prompt: string }
export interface SkillsView { instructions: string; user: Skill[] }
export interface SkillsUpdateRequest { user: Skill[] }
export interface InstructionsUpdateRequest { instructions: string }

// --- 정의 DTO ---
export interface FlowSummary {
  id: string
  name: string
  description?: string | null
  currentVersion: number
  folderId?: string | null
  updatedAt: string
  nodeCount?: number
  nodeTypes?: string[] // 카드 미리보기용 노드 타입(주석 제외, 상한 12)
  nodeCats?: string[] // 노드 카테고리(cat ?: type) — 미리보기 색상
  nodeText?: string | null // 노드 내용 검색용(이름/URL/조건 등, 소문자)
}

export interface FolderSummary {
  id: string
  name: string
  parentId?: string | null // 상위 폴더(null = 루트) — 중첩(트리) 지원
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
  /** 📌 보존 버전(커밋) — 자동 정리에서 영구 제외 */
  pinned?: boolean
}

export interface FlowDetail {
  id: string
  name: string
  description?: string | null
  currentVersion: number
  folderId?: string | null // 에디터 ← 가 소속 폴더로 돌아가기 위함
  createdAt: string | null
  updatedAt: string | null
  graph: FlowGraph
  /** 소속 워크스페이스(null=공용) + 내 롤 — 에디터 VIEWER 읽기전용 모드의 근거 */
  workspaceId?: string | null
  myRole?: 'OWNER' | 'EDITOR' | 'VIEWER' | null
}

export interface CreateFlowRequest {
  name: string
  description?: string
  folderId?: string | null
  /** 소속 워크스페이스 — 'public'/미지정=공용, UUID=팀/개인. */
  workspaceId?: string | null
}

export interface SaveVersionRequest {
  graph: FlowGraph
  note?: string
  /** true = 📌 보존 버전(커밋)으로 저장 — 자동 정리에서 영구 제외 */
  pinned?: boolean
}

// --- 실행 DTO ---
export type ExecutionStatus =
  | 'PENDING' | 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
export type NodeExecutionStatus =
  | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'WAITING' | 'SKIPPED'
export type TriggerType = 'MANUAL' | 'SCHEDULE' | 'WEBHOOK' | 'EVENT'

export interface TriggerView {
  id: string
  flowId: string
  type: TriggerType
  enabled: boolean
  cron?: string | null
  webhookToken?: string | null
  versionNo?: number | null
  nextRunAt?: string | null
  lastRunAt?: string | null
  createdAt: string
}
export interface CreateTriggerRequest {
  type: 'SCHEDULE' | 'WEBHOOK'
  cron?: string
  versionNo?: number
  input?: Record<string, unknown>
  enabled?: boolean
}

export interface RunRequest {
  input?: Record<string, unknown>
  env?: Record<string, unknown>
  envName?: string | null // 활성 환경 이름 — 시크릿 환경 스코프 선택(null/미전송=공통만)
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

// form(팝업) 노드에서 중단될 때, 브라우저가 팝업으로 제출할 폼 명세(값 해석 완료).
export interface PendingFormRequest {
  nodeId: string
  nodeName?: string
  action: string
  method: string
  fields: Array<{ key: string; value?: string | null }>
}

// wait(콜백 대기) 노드에서 중단될 때 넘어오는 대기 명세.
// receiveUrl 은 백엔드가 조립한 콜백 수신 주소({백엔드}/relay/{실행ID}/cb/{노드ID}) — 백엔드가 직접 받아 재개한다.
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

// 백엔드가 수신한 콜백 전문 — wait 재개 페이로드(백엔드가 직접 채워 재개).
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

// 단일 노드 독립 실행 결과 (POST /flows/{id}/nodes/{nodeId}/run)
export interface SingleNodeRunResult {
  ok: boolean
  httpStatus: number | null
  output: unknown
  requestText: string | null
  responseText: string | null
  durationMs?: number | null
}

// TCP 요청 전문 미리보기(전송 없음) — 백엔드가 바이트 단위로 조립한 결과
export interface TcpPreviewField {
  name?: string | null
  offset: number       // 전문 시작 기준 절대 오프셋(프리픽스 포함)
  declaredLen: number
  actualBytes: number  // 값의 원시 바이트 수(패딩/절단 전)
  truncated: boolean   // 초과 절단됨
  padded: boolean      // 패딩으로 채움
  pad: 'left' | 'right'
  text: string
  encoding: string
}
export interface TcpPreview {
  host: string
  port: number
  encoding: string
  totalBytes: number
  prefixLen: number
  declaredPrefix: number | null
  bodyBytes: number
  hex: string          // 공백 구분 2자리 hex
  printable: string
  fields: TcpPreviewField[]
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
  source: 'query' | 'header' | 'body' | 'path' | 'state'
  key: string
  op: 'eq' | 'ne' | 'exists' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'regex' | 'startswith' | 'endswith'
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
  body?: string        // 템플릿: {{path.x}} {{query.x}} {{body.x}} {{header.x}} {{state.x}} {{uuid}} {{seq}} {{now}}
  delayMs?: number
  callback?: MockCallbackSpec | null
  setState?: Array<{ key: string; value: string; op?: 'set' | 'incr' | 'decr' }> // 상태 갱신(op: 대입/증가/감소)
  repeat?: number      // 순차 응답: 이 규칙을 처음 N회 매칭까지만(이후 다음 규칙으로 폴스루)
}
export interface MockRequestLog {
  at: string; method: string; path: string; query: Record<string, string>; headers: Record<string, string>
  bodyText: string; matchedRuleId: string | null; status: number; delayMs: number; callbackFired: boolean
  decodedBody?: string | null // 요청 코덱 적용 결과(코덱 없으면 null)
}
export interface MockStateView { state: Record<string, string>; seq: number; hits: Record<string, number>; requestCount: number }

export interface MockRouteSpec {
  id: string
  method: string // GET/POST/…/ANY
  path: string   // /users/{id}
  rules: MockRuleSpec[]
  codec?: MockCodecSpec | null // 이 라우트만 다른 전문 코덱(서버 codec 대체)
  expect?: MockExpect | null   // 예상 요청 필드
}

// TCP mock — 지정 포트에 고정길이 전문(길이 프리픽스) 리스너를 연다.
// 응답 템플릿: {{req}} 요청 전문 전체 · {{req:오프셋:길이}} 바이트 슬라이스 · {{req.필드}} 요청 레이아웃 필드 · {{seq}} {{now}} {{uuid}}
export interface MockTcpReqField { id: string; name?: string; length?: number; encoding?: string } // 요청 레이아웃(바이트 길이 누적 오프셋)
export interface MockTcpCond { field?: string; op?: 'eq' | 'ne' | 'contains' | 'startswith' | 'endswith' | 'regex' | 'exists'; value?: string }
export interface MockTcpRespField {
  id: string
  name?: string
  length?: number       // 바이트
  value?: string        // 템플릿
  pad?: 'left' | 'right' // 기본 right(문자). 숫자/금액은 left + '0'
  padChar?: string
  encoding?: string     // 필드별(없으면 tcp.charset)
}
export interface MockTcpRuleSpec {
  id: string
  contains?: string // 디코딩된 요청 전문에 포함되면 매칭(비면 항상 = 기본 규칙). when 과 AND
  when?: MockTcpCond[] // 요청 레이아웃 필드 조건(AND)
  response?: string    // 텍스트 템플릿(responseFields 가 비어 있을 때)
  responseFields?: MockTcpRespField[] // 있으면 필드별 바이트 조립이 우선
}
export interface MockTcpPreview {
  encoding: string
  requestFields: Array<{ name: string; offset: number; length: number; value: string; encoding: string }>
  requestBytes: number
  matchedRuleId: string | null
  matchedRuleIndex: number | null
  totalBytes: number
  prefixLen: number
  declaredPrefix: number | null
  bodyBytes: number
  hex: string
  printable: string
  fields: TcpPreviewField[]
  decodedRequest?: string | null   // 요청 코덱이 있을 때 디코딩된 전문
  codecSteps?: MockCodecStepTrace[]
}

export interface MockTcpSpec {
  requestFields?: MockTcpReqField[]
  enabled?: boolean
  port?: number            // 1024~65535
  charset?: string         // 기본 EUC-KR
  prefixLength?: number    // 기본 4 (0 = 프리픽스 없음, 연결당 1전문)
  prefixIncludesSelf?: boolean
  rules?: MockTcpRuleSpec[]
}

// 전문 코덱 — 요청 전문이 매칭·템플릿에 들어가기 전(request) / 응답 전문을 다 만든 뒤 나가기 전(response)
// 변환 플러그인(FlowTransform)을 순서대로 적용. HTTP 본문·TCP 전문 모두 대상. 라우트 codec 이 있으면 서버 codec 대신(통째로).
export type MockCodecTarget = 'body' | 'fields' | 'header'
export interface MockCodecInput { key: string; mode: 'message' | 'value'; value?: string } // 포트별: message=전문/대상 값, value=템플릿({{ x@secret }} 등)
export interface MockCodecStep {
  id: string                                  // 변환 플러그인 id (GET /transforms)
  target?: MockCodecTarget                    // 적용 범위 — body(전문 전체, 기본) | fields(지정 필드만) | header(HTTP 헤더)
  fields?: string[]                           // target=fields — HTTP JSON(점 경로)/urlencoded 키, TCP 레이아웃/응답 필드명
  header?: string                             // target=header — 헤더명(요청 전: 그 값 변환, 응답 후: 본문 입력 → 결과를 헤더에 기록)
  inputs?: MockCodecInput[]                   // 입력 포트 값(없으면 첫 포트=전문, 나머지 빈 값)
  config?: Array<{ key: string; value: string }> // 파라미터(템플릿 허용)
  inputKey?: string                           // v1 호환
  outputKey?: string                          // (기본 첫 출력)
}
export interface MockCodecStepTrace { index: number; id: string; target: string; field: string | null; input: string; output: string }
export interface MockCodecTryResult { result: string; headers: Record<string, string>; fields: Record<string, string>; steps: MockCodecStepTrace[] }
// 예상 요청 정의 — 어떤 요청이 올지 미리 적어 둔 것(피커 소스·조건 키 후보·테스트 샘플). 요청 기록에서 자동 채움.
export interface MockExpectField { key: string; type?: string; example?: string }
export interface MockExpect { body?: MockExpectField[]; query?: MockExpectField[]; header?: MockExpectField[] }
export interface MockCodecSpec {
  request?: MockCodecStep[]
  response?: MockCodecStep[]
}

export interface MockServerSpec {
  routes?: MockRouteSpec[]
  tcp?: MockTcpSpec | null
  codec?: MockCodecSpec | null
  environment?: string | null // 시크릿 스코프({{ 이름@secret }} — 공통 + 이 환경 오버레이). 없으면 공통만
}

// CUSTOM=레거시(HTTP·TCP 둘 다) · HTTP=경로/응답 · TCP=소켓 전문
export type MockKind = 'CUSTOM' | 'HTTP' | 'TCP'

export interface MockServerSummary {
  id: string
  name: string
  slug: string
  kind: MockKind
  enabled: boolean
  updatedAt: string | null
  workspaceId?: string | null
  // 목록 카드 요약(서버가 spec 에서 추출·캐시) + 살아있음 지표(요청 기록) + 현재 버전
  routeCount?: number
  methods?: string[]
  paths?: string[]
  tcpPort?: number | null
  tcpEnabled?: boolean | null
  routeLabels?: string[]    // "GET /pay" — 카드 라우트 미니 스트립(앞 8개)
  tcpRuleCount?: number     // TCP 규칙 수
  tcpFieldCount?: number    // TCP 요청 레이아웃 필드 수
  hasCodec?: boolean
  environment?: string | null
  lastRequestAt?: string | null
  recentRequests?: number   // 최근 60초 요청 수
  requestCount?: number     // 요청 기록 수(최근 100 상한)
  unmatchedRequests?: number // 규칙 무매칭(404) 요청 수 — 대시보드 현황
  currentVersion?: number
}
export interface MockFlowRef { id: string; name: string }

// 서버 현황(fleet) — 모든 워크스페이스의 Mock 을 "실제 서버처럼"(워크스페이스·포트·실제 리스너 상태)
export type WorkspaceRole = 'OWNER' | 'EDITOR' | 'VIEWER'
export interface MockFleetWorkspace { id: string; name: string; kind: 'PUBLIC' | 'PERSONAL' | 'TEAM'; myRole: WorkspaceRole | null; mine: boolean; ownerUsername?: string | null }
export interface MockFleetServer {
  id: string; name: string; slug: string; kind: MockKind; enabled: boolean
  workspaceId: string            // 'public' 또는 UUID
  readable: boolean              // false = 접근 권한 없는 워크스페이스(이름·포트·상태만)
  myRole: WorkspaceRole | null
  tcpPort?: number | null; tcpEnabled?: boolean | null
  listening: boolean             // TCP: 실제 소켓 열림
  listenError?: string | null    // 켜져 있어야 하는데 안 열림
  routeCount: number; routeLabels: string[]; tcpRuleCount: number; tcpFieldCount: number
  hasCodec: boolean; environment?: string | null
  lastRequestAt?: string | null; recentRequests: number; requestCount: number; unmatchedRequests: number
  currentVersion: number; updatedAt?: string | null
  usedBy?: MockFlowRef[]        // 이 Mock 의 base URL 을 쓰는(읽을 수 있는) 워크플로 — readable 일 때만
}
export interface MockFleetPort {
  port: number; kind: 'HTTP' | 'TCP'; state: 'LISTENING' | 'FAILED' | 'OFF'
  mockId?: string | null; mockName?: string | null; slug?: string | null; workspaceId?: string | null; readable: boolean; count: number; error?: string | null
}
export interface MockFleet { workspaces: MockFleetWorkspace[]; servers: MockFleetServer[]; ports: MockFleetPort[]; httpPort: number; contextPath: string; generatedAt: string }
export interface MockVersionSummary { id: string; versionNo: number; note: string | null; createdBy: string | null; createdAt: string; pinned: boolean; routeCount: number; tcpPort: number | null }

export interface MockServerDetail extends MockServerSummary {
  spec: MockServerSpec
  createdAt: string | null
  currentVersion?: number
}

// Mock AI 어시스턴트 — 자연어로 mock spec 생성/수정 (플로우 어시스턴트의 mock 판, Copilot 자격 공유)
export interface MockAssistantChatRequest { messages: AssistantMessage[]; spec?: MockServerSpec | null; mockId?: string; model?: string }
export interface MockAssistantChatResponse { reply: string; spec: MockServerSpec | null; stub: boolean; model: string }

