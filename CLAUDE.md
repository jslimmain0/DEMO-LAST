# FlowLink — 프로젝트 가이드 (유지보수용)

REST API 워크플로 오케스트레이션 플랫폼. 클라이언트 전용 프로토타입(`FlowBuilder.dc.html`)을
엔터프라이즈 플랫폼으로 고도화한 것. 백엔드/프론트 모두 **모듈러 모놀리스**(향후 워커 분리 대비
패키지 경계). UI 텍스트는 전부 한국어.

| | 스택 | 포트 |
|---|---|---|
| **Backend** | Spring Boot 3.3.5 / Java 21 / JPA + Flyway / PostgreSQL(H2 dev) / SpEL | 18080 |
| **Frontend** | React 19 / Vite 8 / @xyflow/react / Zustand / React Query / axios | 5173 |

---

## 실행 방법

### Backend (`backend/`)
```powershell
# H2 파일(영속, Postgres/Docker 불필요) — 재시작해도 데이터 유지
powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -H2
# Postgres + 앱 (백그라운드, 헬스 대기)
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
```
- Swagger UI: `http://localhost:18080/swagger-ui.html`
- Health: `http://localhost:18080/actuator/health` · Prometheus: `/actuator/prometheus`
- DB 접속 override: `FLOWLINK_DB_URL`, `FLOWLINK_DB_USER`, `FLOWLINK_DB_PASSWORD`
- **H2 파일 위치**: 기본 `~/flowlink-h2db/flowlink.mv.db` (사용자 홈). 변경: `FLOWLINK_H2_FILE`. 초기화: 그 `.mv.db` 삭제.
  Hibernate `ddl-auto: update`(스키마 생성/갱신, 데이터 보존). 검증: 플로우 생성→재시작→유지 확인.
- 백그라운드 PID/로그: `backend/.run/`

### Frontend (`frontend/`)
```
npm run dev      # Vite dev (5173). /api → :18080 프록시
npm run build    # tsc -b && vite build
npm run lint     # oxlint
```

### 테스트
```powershell
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"
./gradlew test   # 단위 테스트 3개 (DB 불필요)
```
⚠️ **Gradle 포크 테스트 워커가 한글/비ASCII 경로를 cp949로 잘못 디코딩하는 알려진 이슈**가 있음.
`build.gradle.kts`에 `-Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8` 회피책 적용됨.
앱 빌드/실행(`bootJar`·`bootRun`)은 영향 없음.

---

## 백엔드 구조 (`com.flowlink`)

```
core/        도메인·그래프·리포지토리 (코어, 다른 모듈이 의존)
 ├─ domain   Flow → FlowVersion(불변 스냅샷) / Execution → NodeExecution / Folder
 ├─ graph    FlowGraph·GraphNode·GraphEdge·NodeType·GraphValidator
 └─ repository
definition/  플로우 CRUD·버전·import/export  (FlowController/FlowService)
execution/   실행 엔진 + 실행 API  (ExecutionController/ExecutionService)
 ├─ engine   FlowExecutor·ExecutionContext·ExpressionEvaluator·TokenResolver
 │           HttpNodeExecutor·TcpNodeExecutor·SsrfGuard·NodeRecorder
 └─ config   ExecutionProperties·HttpClientConfig
folder/      폴더 관리
security/    OIDC 리소스서버 골격 + TenantClaimFilter·TenantContext (멀티테넌시)
transform/   변환 SPI + JAR 플러그인 (TransformRegistry·PluginController·BuiltinTransforms)
common/      error·json·tenant·openapi
```

### 도메인 모델 (모두 UUID + tenant_id)
- **Flow** (논리 컨테이너) 1:N **FlowVersion** (불변 그래프 스냅샷, `graph_json` text)
- **Flow** M:1 **Folder** (선택)
- **Execution** (1회 실행) 1:N **NodeExecution** (노드별 결과/로그)
- 상태: `ExecutionStatus`(RUNNING/SUCCEEDED/FAILED/WAITING), `TriggerType`(MANUAL만 동작)

### 실행 흐름 (`FlowExecutor.execute()`)
graphJson 파싱 → Kahn 위상정렬 → 노드 순차 처리 → IF는 단일 분기 선택 →
WAIT 노드 만나면 `WAITING`으로 중단 → 첫 실패 시 `FAILED`.
**현재 완전 동기 실행** (외부 HTTP에 호출 스레드 블로킹).
노드 타입: START/END/SET/IF/HTTP/TRANSFORM/TCP/WAIT.

### 토큰/바인딩 문법 (`TokenResolver`)
- `{{ key }}` — 최근 상위 노드 출력 (nearest upstream)
- `{{ key@nodeId }}` — 명시적 소스
- `{{ key@req:nodeId }}` — 요청 스코프
- 프론트 `lib/tokenGrammar.ts`가 동일 문법을 미러링

### DB 마이그레이션 (`resources/db/migration/`)
- V1: flow / flow_version / execution / node_execution
- V2: flow 낙관적 락 `version` (동시 편집 시 409)
- V3: folder 테이블 + flow.folder_id
- `ddl-auto: validate` + Flyway가 스키마 소유

### 보안
- OIDC: `issuer-uri` 설정 시 자동 활성, 미설정 시 dev permitAll
- 멀티테넌시: JWT claim(기본 "tenant") → `TenantContext`(ThreadLocal) → 쿼리 `tenant_id` 필터
- SSRF 가드: 사설/루프백/링크로컬/메타데이터 대역 차단 + 스킴 allowlist (HTTP·TCP 모두).
  **`flowlink.execution.ssrf.allow-loopback`**: true면 localhost/127.0.0.1/::1 허용(사설망은 여전히 차단) — **h2(로컬) 프로파일 기본 true**.
- redaction deny-by-default: HTTP req/res 본문 기본 미저장 (`flowlink.execution.capture.request-response-bodies`로 옵트인).
  **h2(로컬) 프로파일은 true** — 실행 로그에 요청/응답 본문 그대로 표시(디버그).
- IF 표현식: SpEL `SimpleEvaluationContext`(읽기전용) 샌드박스

### 주요 설정 (`application.yml` / `ExecutionProperties`)
`flowlink.execution.*`: http 타임아웃·max-response-bytes(5MB)·ssrf·capture·max-nodes-per-run(200)

---

## 프론트엔드 구조 (`frontend/src/`)

```
routes/   Dashboard(목록·검색·폴더) · Editor(에디터) · Executions(이력)
store/    editorStore.ts — Zustand. 캔버스 상태(nodes/edges/selectedId/dirty)가 source of truth
api/      client.ts(axios, baseURL /api/v1) · types.ts(백엔드 DTO 미러)
canvas/   FlowCanvas(ReactFlow 래퍼) · NodeCard(generic) · BranchNode(IF, T/F 핸들 2개)
          graphAdapter(toRF/fromRF 변환) · nodeFactory(노드 프로토타입) · nodeMeta · Palette
panels/   PropertyPanel(노드 타입별 설정, 404줄) · RunPanel(실행 로그) · KeyValueEditor
binding/  upstream(상위 노드 BFS 탐색) · BindingChip · BindingPicker(모달)
openapi/  OpenApiImportDialog · parseOpenApi (OpenAPI 3 / Swagger 2 → HTTP 노드)
lib/      format · ids · validation(클라 사이클 검출) · tokenGrammar
design/   theme(라이트/다크) · index.css(CSS 변수)
```

**상태 분리**: Zustand=캔버스 클라 상태, React Query=서버 데이터. 명확히 구분됨.
**RF 노드 타입**: `flnode`(generic) + `branch`(IF). `graphAdapter.rfNodeType()`이 매핑.

### 새 노드 타입 추가 시 (체크리스트)
1. `api/types.ts` — `NodeType` 유니온에 추가
2. `canvas/nodeFactory.ts` — `makeNode()` 프로토타입 + `PALETTE` 배열
3. `panels/PropertyPanel.tsx` — 타입별 UI 섹션 추가
4. `canvas/nodeMeta.ts` — `typeIcon()`·`typeLabel()`
5. 백엔드 `core/graph/NodeType` + `FlowExecutor.processNode()` 핸들러

---

## 알려진 한계 / 미완성 (Phase 2+)

코드 주석·README에 명시된 부채. 유지보수/기능 추가 시 우선 검토:

- **동기 실행** → 비동기 큐/워커·내구성 실행 미구현 (가장 큰 아키텍처 부채). Build vs Buy(Temporal/Camunda) 설계 토론 결론 반영 예정
- **WAIT 노드 재개** 로직 없음 (중단까지만)
- **트리거** CRON/WEBHOOK/EVENT는 enum만, MANUAL만 동작
- **SSRF DNS 리바인딩** 갭 — check-time 해석만, connect-time IP 핀닝 미적용 (`SsrfGuard.java:17`)
- **플러그인 JAR 샌드박스 없음** — 업로드 JAR가 전체 권한으로 실행, RBAC 게이트 필요(현재 permitAll)
- **RBAC/RLS·시크릿 볼트** 미구현 — 멀티테넌시는 `tenant_id` 컬럼 필터링만
- **SET 노드 시크릿** UI 마스킹만, 실제 KMS 연동 없음
- **graph_json** text 저장 — Phase 2에 JSONB 마이그레이션 예정

### 리팩토링 후보 (프론트)
- `PropertyPanel.tsx`(404줄) — 노드 타입별 컴포넌트 분리 권장
- 토스트/에러 알림 시스템 없음 (플러그인 업로드 에러 silent catch)
- Undo/Redo, 서브그래프 복붙, 노드 검색 없음
- OpenAPI 파서: ref 1단계만, YAML 미지원, `allOf/oneOf/anyOf` 미처리

### 테스트 현황
- 백엔드 단위 테스트 3개: `ExpressionEvaluatorTest`·`SsrfGuardTest`·`TokenResolverTest` (DB 불필요)
- E2E/통합 테스트 없음, 프론트 테스트 없음

---

## 최근 변경 (2026-06-29)

### HTTP 노드 요청 방식: 서버→서버 / 클라이언트→서버 (`reqMode`)
- HTTP 노드에 `reqMode: 'server' | 'client'` 선택. PropertyPanel `ReqModeToggle`, NodeCard 배지(S→S/C→S)
- **server**(기본): 백엔드 실행 엔진이 호출(SSRF 가드 적용, 동기) — 기존 동작
- **client**: 브라우저가 직접 호출. 실행 엔진이 client 노드에서 `WAITING`으로 중단하고 조립된 요청을
  `ExecutionDetail.pendingClient`로 반환 → 프론트가 `fetch` → `POST /executions/{id}/resume`로 결과 전송 → 재개.
  이 루프를 [Editor.tsx](frontend/src/routes/Editor.tsx) `onRun`의 while + `callClientRequest`로 반복.
- 백엔드 핵심:
  - `FlowExecutor.RunState`(재개 가능한 진행 상태) + `drive()`/`resume()`로 루프 분리
  - `ExecutionService.suspensions`(인메모리 보관소, ConcurrentHashMap) — **세션/단일 인스턴스 한정**
  - `HttpNodeExecutor.build()`(요청 조립)와 `execute()`(전송) 분리, `clientResult()`로 브라우저 결과→NodeResult
  - DTO: `PendingClientRequest`, `ResumeRequest`, `ExecutionDetail.pendingClient`
- ⚠️ 보관소가 인메모리라 서버 재시작 시 진행 중 실행 소실. 내구성은 후속 과제(WAIT 재개와 동일 한계).
  resume은 실패 시 410/400이 아니라 `BadRequestException`(만료/비대기) 반환.

### 응답 타입별 출력 키 처리 (`respType`)
응답 타입에 따라 "예상 응답 키"의 의미가 다름 — 키형/통짜형으로 분기. 핵심: `TokenResolver.resolveBinding`은
항상 `map.get(key)`라 응답 파싱 결과가 **Map(키-값)** 여야 하위 바인딩이 풀린다.

| respType | 성격 | UI(PropertyPanel) | 백엔드 `HttpNodeExecutor.parseResponse` | 바인딩 소스(`upstream.ts`) |
|---|---|---|---|---|
| `json` | 키형 | 예상 키 입력 | JSON 파싱. 스칼라(42/"hi"/true)는 파싱값을 `body`로, null은 원문 | 선언된 `outputs` |
| `xml` | 키형 | 응답 요소 입력 | 루트 자식 요소 재귀 → 맵(중첩=맵, 잎=텍스트 trim, 중복=리스트). 스칼라 루트(`<amt>1</amt>`)는 **요소명**으로 키잉 | 선언된 `outputs` |
| `form` | 키형 | 응답 필드 입력 | `a=1&b=2` urlencoded → 맵(중복키=리스트) | 선언된 `outputs` |
| `text` | 통짜형 | 키 입력 **숨김** | `{body: 원문}` | `body` 하나만 |
| `binary` | 통짜형 | 키 입력 **숨김** | `{body:"(binary · N bytes)"}` (실제 바이트 길이) | `body` 하나만 |

- 어떤 타입이든 파싱 실패 시 본문을 `body` 키로 보존(유실 방지). 키형에서 `body`는 picker에 없으므로 raw/조건식에 `{{ body@노드 }}`로 수동 바인딩(PropertyPanel 안내 문구 있음).
- `KEYED_RESP = ['json','xml','form']`(PropertyPanel). respType 전환은 비파괴적(`node.outputs` 유지).
- ⚠️ keyed→text/binary 전환 시 기존 출력 키는 무시되고 그 키 바인딩은 끊김 — PropertyPanel이 무시되는 키를 경고로 표시(의도된 비파괴 동작).
- 검증: H2 end-to-end로 json객체/json스칼라(42·"hi"·true·null)/form/form중복키/xml요소/xml스칼라루트/xml중첩/text 바인딩 전부 PASS.
- 적대적 멀티에이전트 리뷰(9건 확정) 반영 완료: 스칼라 정규화, XML 재귀·trim·스칼라루트 키잉, binary 바이트수, UX 경고/안내.

### OpenAPI/Swagger 스키마 추출 ([schema.ts](frontend/src/openapi/schema.ts) — 순수, 단위테스트 가능)
- 스키마 해석을 [parseOpenApi.ts](frontend/src/openapi/parseOpenApi.ts)에서 분리. **응답 outputs 자동 추출 버그 수정**:
  - **배열 응답**(`type:array, items:$ref` — 목록 API) items 언랩 ← 이전에 비어 있던 핵심 버그
  - 중첩 `$ref`, **`allOf` 병합**, **응답레벨 `$ref`**(`#/components/responses`), 200/201/2xx/default, 임의 json 미디어타입(`*+json`)
- 요청 바디 필드에 **타입도 채움**(스키마 type → number/boolean/array/json/string) — 필드 타입 기능과 연동.
- 검증: schema 단위테스트(Node 타입스트리핑) 13케이스 PASS. ⚠️ `oneOf`/`anyOf`(유니온)은 미평탄화(미지원).

### OpenAPI import → 왼쪽 팔레트 그룹 (플로우에 저장)
- import 시 캔버스에 바로 배치하지 않고 `FlowGraph.palette` 그룹으로 적재 → Palette에서 드래그/클릭으로 캔버스에 추가
- 드래그 페이로드: `application/flowlink-template`(노드 JSON), 기존 기본 노드는 `application/flowlink-node`(타입)
- editorStore: `palette` 상태 + `addNodeFromTemplate`/`addPaletteGroup`/`removePaletteGroup`/`removePaletteItem`
- `palette`는 graph JSON에 함께 저장 — **백엔드는 graph를 raw 저장이라 스키마 변경 없음**(`FlowGraph.java` record엔 미정의, 라운드트립으로만 보존). 단 export/import 포맷(nodes/edges)에는 미포함.

### 에디터 패널 크기조절 (드래그) + 드래그 폴리시
- 좌측 팔레트·우측 속성·하단 실행로그를 경계 핸들 드래그로 크기조절. 재사용 [ResizeHandle](frontend/src/components/ResizeHandle.tsx).
- **포인터 캡처 모델**: `setPointerCapture` + `pointermove`/`pointerup`/`pointercancel`를 핸들 요소에 바인딩 →
  캔버스 위/창 밖/제스처 취소에서도 안전 종료(전역 커서·리스너 누수 방지). 언마운트 시 `cleanupRef`로 정리.
- 키보드: 화살표(Shift로 ±32) 조절, `role="separator"` + aria-valuenow/min/max. 포커스는 호버와 구분되는 표면 틴트.
- 크기 `localStorage`(`fl:editor:*`) 지속 — **드래그 끝에 1회 저장**. 로드 시 min/max 클램프.
- **뷰포트 동적 상한**: 패널 max를 창 크기에 비례(`vp.w*0.35/0.45`, `vp.h-160`)로 산출하고 창 리사이즈 시 재클램프 →
  좁은/낮은 화면에서 캔버스가 0이 되거나 오버플로되지 않음. root·row에 `overflow:hidden` 안전망.
- 분할선(`.fl-resize-handle::before`)을 캔버스쪽 가장자리에 핀하고 핸들 배경=surface → 거터 없이 flush.
- `[draggable]` 노드/템플릿 끌 때 grab/grabbing 커서.
- 적대적 리뷰(9건) 반영: 포인터 견고성(캡처/취소/언마운트), 뷰포트 오버플로, 포커스 가시성, flush 분할선.
- ⚠️ 패널 사이즈는 Editor 로컬 상태(브라우저별 localStorage). 서버/플로우에 저장 안 됨.

### 워크플로 export/import (파일·텍스트) + 연결 핸들 자석
- **워크플로 JSON 입출력**: 에디터 탑바 가져오기/내보내기 → [WorkflowIODialog](frontend/src/openapi/WorkflowIODialog.tsx).
  내보내기=현재 그래프 JSON 복사/파일다운로드, 가져오기=파일/붙여넣기 → `editorStore.importGraph`(flowId 유지, dirty).
  기존 OpenAPI import(팔레트)는 **API** 버튼으로 분리. (탑바: API / 가져오기 / 내보내기 / 실행 / 저장)
- **가져오기 검증**: nodes 배열·노드 id 유무/중복·edges 배열을 사전 검사(에러 표시), `toRF`도 `Array.isArray` 방어,
  `importGraph`가 댕글링 엣지 제거. → 손편집/외부 JSON 붙여넣기에도 React Flow 키 깨짐/크래시 없음.
- **연결 핸들(원) 크기 + 자석**: [FlowCanvas](frontend/src/canvas/FlowCanvas.tsx) `connectionRadius={45}`(자석 스냅),
  핸들 12px → 노드/핸들 호버 16px → 연결 드래그·클릭 중 18px+후광(`.fl-canvas.connecting`, drag+click 모두 wiring).
  핸들 스타일은 `.react-flow__handle.fl-handle`(index.css). 창 포커스 상실 시 확대 고착 방지 reset.
- **모달 공통**: [useEscapeClose](frontend/src/components/useEscapeClose.ts) — Esc 닫기를 3개 다이얼로그(Workflow/OpenAPI/BindingPicker)에 적용.
- 2차 적대적 리뷰(11건) 반영: 가져오기 검증, stale memo, 클립보드 폴백, 클릭-연결 자석, Esc/autoFocus.
  ⚠️ 핸들 키보드 포커스는 xyflow 핸들이 비포커스 div라 미지원(클릭-연결 자석으로 대체).

### HTTP 문자셋(charset) + urlencoded 응답 타입
- **urlencoded 응답 타입 추가**: `RespType = json | xml | urlencoded | form | text | binary`. `urlencoded`/`form` 모두
  `a=1&b=2`를 키-값 맵으로 파싱(키형). 백엔드 `parseResponse`: `case "form","urlencoded" -> parseForm`.
- **charset 선택**(내부망 EUC-KR/MS949 레거시용): HTTP 노드에 `charset` 필드(UTF-8 기본 / EUC-KR / MS949 / US-ASCII).
  PropertyPanel 드롭다운, `GraphNode.charset`.
- **server 모드 적용**: 응답 바이트를 선택 charset으로 디코딩(`readRaw(response, cs)`), 요청 쿼리/폼은 `URLEncoder(s, cs)`,
  본문은 `body.getBytes(cs)` 바이트로 전송, 비UTF-8이면 Content-Type에 `; charset=…` 부착. UTF-8이면 wire 동일(무회귀).
  검증: EUC-KR 디코딩 데모로 한글 복원 입증, urlencoded 바인딩 end-to-end, charset 라운드트립.
- **적대적 리뷰(6건) 반영**:
  - MS949는 Content-Type에 JVM 정규명 `x-windows-949` 대신 **IANA명 `windows-949`** 로 표기(`wireCharset`) — 비JVM 레거시 호환.
  - **client 모드**: 브라우저 fetch가 본문을 UTF-8로 보내고 응답 디코딩도 브라우저가 처리하므로,
    Content-Type charset 미부착 + PropertyPanel 경고(선택 charset은 server 모드에서 완전 적용). urlencoded/form 요청은 client에서도 정상.
  - binary 바이트수는 실제 수신 바이트(`RawResponse.byteLength`)로(이전엔 charset 재인코딩 오류).
- ⚠️ client 모드 charset은 브라우저 제약으로 raw/xml/json 본문의 비UTF-8 인코딩은 미보장 — server 모드 권장.

### 요청 바디 [필드 ↔ Raw] 전환 + 양방향 변환 + 탭 힌트
- json/urlencoded/form 바디는 **키-값(필드)** 과 **원문(Raw)** 을 토글로 전환(PropertyPanel `miniSeg`). 플래그 `jsonRaw`.
- **양방향 변환(치환)**: 토글 시 내용을 실제로 변환 — Raw `{"name":"kim"}` ⇄ 필드 `name|kim`, urlencoded `a=1&b=2` ⇄ 필드.
  순수 함수 [lib/bodyConvert.ts](frontend/src/lib/bodyConvert.ts) `fieldsToRaw`/`rawToFields`. (초기 구현은 변환 없이 따로 보관하는 버그였음 → 수정)
- **bodyType 변경 시도 변환/정규화**(`changeBodyType`): 구조형↔구조형은 Raw 내용을 새 포맷으로 재직렬화, raw/xml 경계는
  `jsonRaw` 정리 → "보이는 것 = 보내는 것" 보장(json Raw를 urlencoded로 그대로 보내는 버그 방지).
- 백엔드 `HttpNodeExecutor.build()`: urlencoded/form에도 `jsonRaw` raw 분기. **필드 JSON 값은 문자열**(백엔드 한계) —
  바인딩/숫자/불리언은 Raw에서 따옴표 문자열이 되어 안내 문구 표시.
- **탭 힌트**: Params(쿼리스트링)/Headers/Body(요청 본문) 각각 설명 추가 — "body vs param" 혼란 해소.
- 검증: bodyConvert 단위테스트(Node 타입스트리핑) 사용자예시·라운드트립·크로스포맷·예외 28케이스 PASS. 적대적 리뷰 3건 반영.
- ⚠️ 토글은 Body 탭 안에 있음(기본 탭은 Params). raw/xml은 textarea 전용(토글 없음).

### JSON 바디 필드 타입(따옴표 여부): string/number/boolean/json/array
- `NodeField.type` 추가. **JSON 바디**에서 값의 타입을 골라 따옴표 여부를 제어(KeyValueEditor에 타입 `<select>`, `showType`).
- 백엔드 `HttpNodeExecutor.coerceJson(value, type)`: number→숫자, boolean→불리언, json/array/object→내장(파싱), null→null,
  **string/미지정=기존 동작(네이티브, 무회귀)**. 파싱 실패 시 원값 보존. 리터럴·바인딩 모두 적용.
- bodyConvert가 타입 인지: raw→필드 시 JSON 값에서 타입 추론(number/boolean/array/json/string), 필드→raw 시 타입대로 직렬화.
  토큰(바인딩)은 유효 JSON 유지 위해 따옴표 문자열로(타입 강제는 필드 모드 백엔드에서).
- ⚠️ Java 함정: `cond ? Double : Long` 삼항은 double로 승격(정수 30→30.0). 분리 `yield`로 타입 보존.
- 검증: bodyConvert 타입 라운드트립 단위테스트 18케이스 + 백엔드 코어션 end-to-end(string/int/float/bool/array/json/폴백) PASS.

---

## 참고 문서
- `backend/README.md` — Phase 1 구현 범위 표, API 요약, 실행 가이드
- `docs/` — UI/UX 멀티에이전트 설계 토론 로그, 엔터프라이즈 고도화 설계
