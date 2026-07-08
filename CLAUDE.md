# FlowLink — 프로젝트 가이드 (유지보수용)

REST API 워크플로 오케스트레이션 플랫폼. 클라이언트 전용 프로토타입(`legacy/FlowBuilder.dc.html`)을
엔터프라이즈 플랫폼으로 고도화한 것. 백엔드/프론트 모두 **모듈러 모놀리스**(향후 워커 분리 대비
패키지 경계). UI 텍스트는 전부 한국어.

| | 스택 | 포트 |
|---|---|---|
| **Backend** | Spring Boot 3.3.5 / **Kotlin 1.9**(Java 21 toolchain) / JPA + Flyway / PostgreSQL(H2 dev) / SpEL | 18080 |
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

### wait(콜백 대기) 콜백 — 백엔드 통합 (별도 프로세스 없음)
`wait` 노드의 콜백은 **백엔드가 직접** `/relay/{execId}/cb/{nodeId}` 로 받아 실행을 자동 재개한다
([RelayController](backend/src/main/kotlin/com/flowlink/execution/RelayController.kt)). 타임아웃도 백엔드
스케줄러가 구동 → **브라우저 없이 wait 가 완결**된다(구 relay.js:8787 프로세스는 폐기).
- 무인증(외부 시스템이 부르는 엔드포인트, `execId` 는 추측 불가한 UUID) + CORS 오픈, 전체 예외 가드로 500 JSON.
- GET/HEAD 는 쿼리스트링을, 그 외는 요청 본문(소진된 urlencoded 는 파라미터 맵에서 복원)을 콜백 본문으로 사용.

### Mock 서버 기능 (백엔드 내장 · UI 상단 "Mock 서버" 탭)
FlowLink 안에서 **가짜 대상 시스템을 만들고 켜는 1급 기능**. 저장 즉시 `http://localhost:18080/mock/{slug}/**` 로 서빙(별도 프로세스 없음).
- method+경로(`/users/{id}`)마다 규칙(조건·응답 템플릿·charset·지연·**콜백 발사**)을 UI 에서 정의(전부 사용자 정의 커스텀 목).
- 응답 `contentType: html` + `{{body.returnUrl}}` 템플릿으로 **결제창 같은 웹페이지가 뜨고 콜백하는** 흐름도 만든다.
- 워크플로 HTTP/폼 노드의 baseUrl 에 mock base URL 을 넣어 호출. 미완성 시스템을 mock 으로 세워 전체 흐름을 먼저 검증.
- **TCP 전문 mock**(2026-07-06): spec 의 `tcp` 섹션(포트·문자셋·길이 프리픽스·contains 규칙)을 저장하면 백엔드가 그 포트에 TCP 리스너를 연다 — 워크플로 TCP 노드의 가짜 대상 시스템. 응답 템플릿 `{{req}}`/`{{req:오프셋:길이}}`.
- 상세: [docs/superpowers/specs/2026-07-04-mock-server-builder-design.md](docs/superpowers/specs/2026-07-04-mock-server-builder-design.md), 결제창+콜백 데모 [demos/pay-mock/README.md](demos/pay-mock/README.md).
- ⚠️ 상태 관리(부분취소 잔액 원장 등)는 범위 밖(범용 무상태 목) — 상태 있는 시뮬레이터가 필요하면 별도 프로세스로 세워 baseUrl 로 호출.

### 데모 워크플로 (리포 루트 · `demos/`)
```
node demos/seed-mock.mjs   # 백엔드(:18080)에 slug `demo` mock 을 생성/갱신(1회) — 의존성 0
```
- `demos/demo-01~04·06-*.json` 은 위 **내장 Mock**(base `http://localhost:18080/mock/demo`)을 대상으로 한다.
  seed 스크립트가 결제 게이트웨이·REST API·레거시 EUC-KR 라우트를 백엔드에 심는다(별도 mock 프로세스 불필요).
  내장 Mock 서버 편집기로 세우는 데모는 `demos/pay-mock/*.json`(slug `pay-mock`). 상세: [demos/README.md](demos/README.md).

### 테스트
```powershell
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"
./gradlew test   # 단위 테스트 4개 (DB 불필요)
```
⚠️ **Gradle 포크 테스트 워커가 한글/비ASCII 경로를 cp949로 잘못 디코딩하는 알려진 이슈**가 있음.
`build.gradle.kts`에 `-Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8` 회피책 적용됨.
앱 빌드/실행(`bootJar`·`bootRun`)은 영향 없음.

---

## 백엔드 구조 (`com.flowlink`)

> **2026-07-05 전체 Kotlin 이관 완료** — `src/main/kotlin`·`src/test/kotlin`만 존재(Java 0). 패키지/모듈 경계·동작은 동일, 언어만 Kotlin(record→data class, static→companion `@JvmStatic`, JPA 엔티티는 일반 class + `plugin.jpa` no-arg / `plugin.spring` all-open). ⚠️ **Jackson 역직렬화 대상(DTO·값 record)에는 `@get:JvmName` 금지** — jackson-module-kotlin 이 오인식해 컬렉션/Map 역직렬화가 깨진다(MockSpec 회귀로 확인). Java 호출부가 없어져 accessor 대신 프로퍼티 접근(`node.id`)이 기본.

```
core/        도메인·그래프·리포지토리 (코어, 다른 모듈이 의존)
 ├─ domain   Flow → FlowVersion(불변 스냅샷) / Execution → NodeExecution / Folder
 ├─ graph    FlowGraph·GraphNode·GraphEdge·NodeType·GraphValidator
 └─ repository
definition/  플로우 CRUD·버전·import/export  (FlowController/FlowService)
execution/   실행 엔진 + 실행 API  (ExecutionController/ExecutionService)
 ├─ engine   FlowExecutor·ExecutionContext·ExpressionEvaluator·TokenResolver
 │           HttpNodeExecutor·SsrfGuard·NodeRecorder
 │           RelayController(wait 콜백 수신 → 자동 재개)
 └─ config   ExecutionProperties·HttpClientConfig
folder/      폴더 관리
mock/        Mock 서버 기능 — 워크플로가 호출할 가짜 대상 시스템을 정의·서빙(1급 리소스)
 │           MockServerController(관리 CRUD)·MockGatewayController(/mock/{slug}/** 서빙)
 │           MockRuntime(라우트 매칭·조건·템플릿)·MockCallbackDispatcher(콜백 발사)
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
브라우저 협업 노드(client HTTP / FORM / WAIT / INPUT)를 만나면 `WAITING`으로 중단하고 pending 명세 반환 →
브라우저가 처리 후 `POST /executions/{id}/resume` → 첫 실패 시 `FAILED`, 사용자 중단(⏹)은 `CANCELLED`.
**현재 완전 동기 실행** (외부 HTTP에 호출 스레드 블로킹).
노드 타입: START/END/SET/IF/ASSERT/SWITCH(경로 스위치 — 선로 전환기)/HTTP/FORM/INPUT/WAIT/TRANSFORM/TCP(고정길이 전문) + 주석 NOTE/GROUP(`isAnnotation()` — 실행 제외).
- **ASSERT(검증)**: IF 와 같은 SpEL 조건이지만 분기 대신 **거짓이면 노드 실패**(=실행 FAILED). 테스트 시나리오 판정용.
  SimpleEvaluationContext(읽기전용)라 비교·논리·산술·문자열 연결(`+`)만 되고 `.contains()`·`.startsWith()` 메서드 호출은 차단.

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
- SSRF 가드: 사설/루프백/링크로컬/메타데이터 대역 차단 + 스킴 allowlist (HTTP 아웃바운드 + mock 콜백 발사).
  **`flowlink.execution.ssrf.allow-loopback`**: true면 localhost/127.0.0.1/::1 허용(사설망은 여전히 차단) — **h2(로컬) 프로파일 기본 true**.
- redaction deny-by-default: HTTP req/res 본문 기본 미저장 (`flowlink.execution.capture.request-response-bodies`로 옵트인).
  **h2(로컬) 프로파일은 true** — 실행 로그에 요청/응답 본문 그대로 표시(디버그).
- IF 표현식: SpEL `SimpleEvaluationContext`(읽기전용) 샌드박스

### 주요 설정 (`application.yml` / `ExecutionProperties`)
`flowlink.execution.*`: http 타임아웃·max-response-bytes(5MB)·ssrf·capture·max-nodes-per-run(200)
(외부 콜백은 백엔드가 `/relay/{execId}/cb/{nodeId}` 로 직접 수신 → 자동 재개. 별도 relay 프로세스·설정 없음)

---

## 프론트엔드 구조 (`frontend/src/`)

```
routes/   Dashboard(목록·검색·폴더) · Editor(에디터) · Executions(이력) · MockServers·MockServerEditor(Mock 서버)
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
- **재개 상태 인메모리**(`ExecutionService.suspensions`) — 서버 재시작 시 진행 중 실행 소실. API 로 직접 실행(브라우저 없이)하면 wait 에서 WAITING 으로 남음(브라우저가 타임아웃을 구동)
- **트리거** CRON/WEBHOOK/EVENT는 enum만, MANUAL만 동작
- **SSRF DNS 리바인딩** 갭 — check-time 해석만, connect-time IP 핀닝 미적용 (`SsrfGuard.kt`)
- **플러그인 JAR 샌드박스 없음** — 업로드 JAR가 전체 권한으로 실행, RBAC 게이트 필요(현재 permitAll)
- **RBAC/RLS·시크릿 볼트** 미구현 — 멀티테넌시는 `tenant_id` 컬럼 필터링만
- **SET 노드 시크릿** UI 마스킹만, 실제 KMS 연동 없음
- **graph_json** text 저장 — Phase 2에 JSONB 마이그레이션 예정

### 리팩토링 후보 (프론트)
- `PropertyPanel.tsx`(404줄) — 노드 타입별 컴포넌트 분리 권장
- 토스트/에러 알림 시스템 없음 (플러그인 업로드 에러 silent catch)
- 노드 검색 없음 (Undo/Redo·서브그래프 복붙은 2026-07-06 구현됨)
- OpenAPI 파서: ref 1단계만, YAML 미지원, `allOf/oneOf/anyOf` 미처리

### 테스트 현황
- 백엔드 단위 테스트 4개: `ExpressionEvaluatorTest`·`SsrfGuardTest`·`TokenResolverTest`·`MockRuntimeTest` (DB 불필요)
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
| `query` | 키형 | 응답 필드 입력 | 본문이 URL(`…?a=1&b=2`)/쿼리스트링이면 `?` 뒤(프래그먼트 제거) → `parseForm` 맵. `?` 없으면 한 줄 `a=1&b=2` 만 인정 | 선언된 `outputs` |
| `text` | 통짜형 | 키 입력 **숨김** | `{body: 원문}` | `body` 하나만 |
| `binary` | 통짜형 | 키 입력 **숨김** | `{body:"(binary · N bytes)"}` (실제 바이트 길이) | `body` 하나만 |

- 어떤 타입이든 파싱 실패 시 본문을 `body` 키로 보존(유실 방지). 키형에서 `body`는 picker에 없으므로 raw/조건식에 `{{ body@노드 }}`로 수동 바인딩(PropertyPanel 안내 문구 있음).
- `KEYED_RESP = ['json','xml','urlencoded','form','query']`(PropertyPanel). respType 전환은 비파괴적(`node.outputs` 유지).
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

## 최근 변경 (2026-07-03)

### form/wait 노드 분리 + relay.js — 콜백 경로 전면 재설계
설계: [docs/superpowers/specs/2026-07-03-form-wait-relay-design.md](docs/superpowers/specs/2026-07-03-form-wait-relay-design.md).
아래 구(舊) 3개 섹션(폼 전송 WAIT type · `{{ __callbackUrl }}` · `{{ __notiUrl }}`/`{{ __corrId }}`)의 장치는 **전부 제거되고 이 구조로 대체**됐다.
- **노드 분리**: `form`(폼 전송·팝업 — `window.open('', 'flowlink_pay_{노드ID}', 480x720)` 에 hidden form 자동 submit 후 **기다리지 않고 즉시 진행**, 팝업 차단/URL 공백은 노드 실패) / `wait`(콜백 대기 — 타임아웃 기본 120초, 콜백에 줄 응답(text/html/json+본문) 설정, 수신 URL 표시+`{{ url@노드ID }}` 토큰 복사). 하위호환: `type=wait && formAction` 저장 그래프는 로드(`graphAdapter.migrateNode`)·실행(`GraphNode.effectiveType()`) 양쪽에서 form 으로 간주.
- **relay.js**(리포 루트, node:http, 의존성 0, :8787): `POST /exec/{실행ID}/register`(노드별 응답 설정) · `GET /events/{실행ID}`(SSE, 기수신분 재생+25초 ping) · `ANY /cb/{실행ID}/{노드ID}`(보관+SSE 전달+등록 응답 반환, GET 은 쿼리스트링=본문) · `/health` · 그 외 `frontend/dist` 정적 서빙. 메모리 상태, 실행ID별 2시간 정리. CORS 오픈.
- **실행 프로토콜**: 프론트가 실행 직전 crypto 영숫자 16자 `relayRunId` 생성 → relay 등록+SSE 연결(실패는 기억만 — wait 도달 시 그 에러로 실패, form/http/set 만 있으면 relay 없이 동작) → `RunRequest{relayRunId, relayBase}` → 백엔드가 **모든 wait 노드의 url 출력을 실행 시작 시 ctx 에 시드** → `{{ url@노드ID }}` 가 wait 보다 앞 노드(returnUrl/notiUrl)에서도 해석(TokenResolver 무변경). wait 도달 → `pendingWait{nodeId, timeoutSec, receiveUrl}` → 프론트가 콜백(노드ID별 버퍼 큐, SSE)·타임아웃·⏹중단 중 먼저 온 것으로 resume. 콜백 본문은 `tryParseCallbackBody`(JSON→urlencoded→원문 body 키)로 파싱돼 노드 출력(전 키) + url 병합 → 다운스트림 바인딩. 사용자 중단은 `aborted=true` → 실행 `CANCELLED`(신규 `Execution.markCancelled`).
- **프론트**: `lib/relay.ts`(RelaySession — register/SSE/버퍼/take·cancelWait) · `lib/popup.ts`(openFormPopup — DOM 조립이라 이스케이프 불요, 창 이름 고정 재사용) · Editor 실행 루프 확장(pendingForm 즉시 재개·pendingWait 대기·⏹ 중단 버튼·실행 중 beforeunload 경고) · RunPanel(카운트다운 0.3초 갱신·수신 URL 클릭 전체선택/복사·⏹) · 캔버스 wait 펄스(`fl-wait-dot`)+유입 엣지 애니메이션(editorStore.waitingNodeId) · 바인딩 피커가 그래프 내 wait 수신 URL 을 전 노드에서 노출(`upstream.bindableSources`) · FormPopupDialog 삭제.
- **백엔드 제거**: `{{ __callbackUrl }}`/`{{ __notiUrl }}`/`{{ __corrId }}` 치환, `/executions/callback/{token}`·`/callbacks` 엔드포인트, callbackTokens/corrIds 레지스트리, `ExecutionProperties.Callback`, SecurityConfig PUBLIC_PATHS 콜백 항목.
- 검증: 단위 3종 PASS + H2 e2e 24 케이스 PASS(정상 흐름·URL 시드·타임아웃·CANCELLED·팝업 차단·빈 URL·하위호환·relay 미연동·JSON 파싱·SSE 재생·시드 오염 회귀) + 프론트 tsc/vite/oxlint 통과.
- **input(사용자 입력) 노드**: 실행이 도달하면 브라우저 모달(안내 메시지 + 입력 필드)이 뜨고, 값을 입력해 확인(Enter)하면
  각 키가 노드 출력이 되어 다음 노드에서 `{{ 키@노드ID }}` 바인딩. 필드 타입(string/number/boolean/json) — json 이면
  객체/배열이 그대로 전달(파싱·검증은 브라우저 confirm 시점, 서버는 `ResumeRequest.formValues` 저장만). 취소(Esc)=CANCELLED.
  설정은 기존 `waitMsg`/`waitFields`(+`type`) 재사용. 하위호환: `type=wait && waitFields`(콜백 설정 없음) 구 그래프는
  로드·실행 모두 input 으로 승격(`migrateNode`/`effectiveType`). 백엔드 `pendingInput`, 프론트 [InputPromptDialog](frontend/src/components/InputPromptDialog.tsx).
- **적대적 멀티에이전트 리뷰(4확정+2보강) 반영**: (1) wait URL 선시드가 bare `{{ url }}` 해석을 오염(input/상류 가림) → `ExecutionContext.putSeed`(별도 저장소, 명시 스코프 `{{ url@id }}`/바인딩에만 raw 폴백으로 보임). (2) 고정 이름 팝업이 교차출처 게이트웨이로 이동한 뒤 재실행하면 `popup.document` 접근이 SecurityError → **opener 문서에서 `target=창이름` 제출**로 변경(인터스티셜은 새 about:blank 창일 때만). (3) relay 정적 서빙의 `decodeURIComponent` 가 malformed percent-encoding 에 throw → 프로세스 사망(전 실행 소실) → try/catch + 핸들러 전체 500 가드. (4) 상한 초과 콜백이 빈 본문 이벤트로 조용히 전달 → 413 거절. (+) ⏹ 중단을 모든 중단 지점(loop-top)에서 존중, relay register fetch 에 5초 타임아웃.
- ⚠️ 콜백 무인증(사내 테스트망 전제 — relayRunId 가 비밀값), 탭 닫으면 실행 끊김(beforeunload 경고만), relay 메모리 상태 재시작 소실.

---

## 최근 변경 (2026-07-04)

### Mock 서버 기능(백엔드 내장) + 검증(assert) 노드 + pay-mock 데모 2종
설계: [docs/superpowers/specs/2026-07-04-mock-server-builder-design.md](docs/superpowers/specs/2026-07-04-mock-server-builder-design.md).
"워크플로 기능과 Mock 서버 기능이 둘 다 있어서, 미완성 부분은 mock 으로 세워 테스트한다"는 요구를 1급 기능으로 구현.
- **백엔드 `mock/` 모듈**: `MockServer` 도메인(V4 마이그레이션, slug 전역 유니크) + 관리 CRUD(`/api/v1/mock-servers`,
  테넌트 스코프) + **게이트웨이 `/mock/{slug}/**`**(무인증 permitAll·CORS 오픈·전체 예외 가드로 500 JSON).
  - `MockRuntime`(순수): 라우트 매칭(`/users/{id}` 파라미터·ANY·정의순서 첫매칭)·조건 규칙(AND, eq/ne/exists/contains)·
    응답 템플릿(`{{path.x}}`·`{{query.x}}`·`{{body.x}}`·`{{header.x}}`·`{{body}}`·`{{uuid}}`·`{{seq}}`·`{{now}}`)·
    charset(EUC-KR/MS949→windows-949)·지연 cap·콜백 발사 명세. 단위테스트 7종.
  - `MockCallbackDispatcher`: 지연 발사 + "OK" 미수신 시 2초 간격 3회 재발송(노티 규약), SsrfGuard 적용.
- **ASSERT 노드**: 위 노드 타입 설명 참조. SpEL 조건 거짓 → 노드 실패 → 실행 FAILED.
- **프론트**: 상단 "Mock 서버" 탭 — 목록(생성·enabled 토글·base URL 복사·삭제) + 편집기(라우트/규칙/템플릿/콜백 편집·보내보기).
  `routes/MockServers.tsx`·`MockServerEditor.tsx`.
- **demos/pay-mock**: 커스텀 mock 으로 "결제창(HTML 팝업)→승인→콜백"(01) · "무인 노티 자동 발사"(02) 재현. assert 로 판정.
- 검증: 백엔드 단위 4종(mock 8 포함) PASS + 라이브 e2e — 결제창+콜백/무인노티 14 단언, 커스텀 라우트 7 단언 PASS,
  기존 demos(47)·form-wait(31) 무회귀. 프론트 tsc/vite/oxlint 통과.
- **적대적 멀티에이전트 리뷰(38 에이전트, 4차원×2표 반박) 반영**: (1) 게이트웨이 경로에 `URLDecoder.decode`(form 디코더) 사용 →
  경로의 `+`가 공백으로 변질(경로 파라미터·조건 오염) → 세그먼트별 percent-only `decodePath`로 교체. (2) PUT/PATCH/DELETE +
  urlencoded 본문이 Spring FormContentFilter 에 소진돼 `getInputStream()` 이 빈 값 → 파라미터 맵에서 `recoverFormBody` 로 복원.
- **PG 프리셋 제거(사용자 피드백)**: 상태 있는 가짜 결제 게이트웨이(`MockPgSimulator`)는 범용 mock 도구에 특정 도메인을 하드코딩한
  것이라 걷어냄. "결제창 뜨고 콜백"은 커스텀 라우트(HTML 응답+콜백 발사)로 충분. `MockServer.Kind` 는 CUSTOM 하나만.
- ⚠️ mock 서빙 무인증(테스트 도구 전제, slug 는 비밀값 아님)·상태 없음(범용 목)·콜백 SsrfGuard 적용(운영 프로파일은 사설망 발사 차단).

### mock 대상 시스템(mock-server.js) + 데모 워크플로 스위트(demos/)
설계: [docs/superpowers/specs/2026-07-04-mock-demo-suite-design.md](docs/superpowers/specs/2026-07-04-mock-demo-suite-design.md).
"모든 기능을 실제로 테스트"하기 위한 가짜 대상 시스템 + 완성 데모 6종. **백엔드/프론트 코드 무변경**(기존 기능만 사용).
- **mock-server.js**(리포 루트, node:http+node:net, 의존성 0, HTTP :9090 · TCP :9091): 위 실행 방법 섹션 참조.
  결제 게이트웨이는 결제창(승인/거절 버튼)→`/pay/approve`→returnUrl 자동 POST 브리지(실 PG merchant-return 패턴),
  notiUrl 서버 노티(파이어&포겟)도 지원. EUC-KR 응답은 Node 가 인코딩 불가(TextEncoder=UTF-8 전용)라
  고정 문자열("홍길동")의 EUC-KR 바이트를 하드코딩, 요청 디코딩은 `TextDecoder('euc-kr')`.
  TCP 는 TcpNodeExecutor 규약(4자리 ASCII 길이 프리픽스·자기 미포함) 그대로 구현.
- **demos/*.json 6종**: 01 결제(SET·FORM·WAIT·IF·HTTP — 타임아웃/거절 분기 포함), 02 OTP(INPUT, waitMsg 에
  `{{ hint@… }}` 토큰), 03 주문 API(Bearer 헤더 바인딩·qty number 타입·경로 바인딩·concat TRANSFORM),
  04 레거시 EUC-KR(charset·urlencoded/xml respType), 05 TCP 전문(EUC-KR 고객명 슬라이싱), 06 클라이언트 모드(C→S).
  IF 분기 엣지는 `fromPort:"true"/"false"`, 일반 엣지는 생략(기본 `out`).
- 검증: 라이브 스택(H2 백엔드+relay+mock) e2e **47/47 PASS**(승인/거절·OTP 정답/오답·EUC-KR 복원·TCP 슬라이싱·
  클라이언트 모드 재개) + mock `/openapi.json` 을 프론트 `parseOpenApi` 로 파싱 **7/7 PASS**(배열 언랩·allOf 병합·
  응답레벨 $ref·qty=number 필드 타입).
- ⚠️ mock 상태(주문/tid) 인메모리 — 재시작 시 소실. OpenAPI 임포트는 붙여넣기 전용(다이얼로그가 URL 페치 미지원).

## 이전 변경 (2026-06-29) — ⚠ 아래 3개 콜백 섹션은 2026-07-03 재설계로 **대체됨** (역사 기록용)

### (대체됨) 폼 전송 노드(WAIT type) — 새 창(팝업)으로 form target 제출
- WAIT 노드를 **`폼 전송`으로 재정의**(결제/인증창 패턴): 실행 시 **새 팝업 창**을 열고 `<form action method target=팝업>`을
  그 창으로 제출 → 대상 페이지가 팝업에 렌더. 팝업이 `postMessage`로 결과를 보내거나 **창이 닫히면**(`{closed:true}`) 재개.
  결과값이 노드 출력이 되어 다운스트림 바인딩. ([FormPopupDialog](frontend/src/components/FormPopupDialog.tsx))
- 노드 설정: `formAction`(URL, 토큰/바인딩), `formMethod`(POST/GET), **폼 데이터는 `fields.body`**(KeyValueEditor, 바인딩). `outputs`로 결과 키 선언.
- 백엔드: WAIT 중단 시 `formAction`(토큰 해석)·필드 값(바인딩 해석)을 서버에서 완성해 `PendingForm{action,method,fields}` 반환.
  `FlowExecutor.resume`은 노드 타입 분기(HTTP=브라우저응답 / WAIT=formValues를 출력으로). `RunState.pendingNodeId` HTTP/WAIT 공용.
- 프론트: 팝업 차단 대비 **버튼 클릭(제스처)으로 창 열기** → 폼 제출 → `postMessage`/창닫힘 대기(언마운트 시 리스너 정리).
- 검증: H2 e2e — action 토큰 해석(`{{url@s}}/pay`)·필드 바인딩(tok=TOK-9)·결과 재개(ok→APPROVED 다운스트림) PASS, client 모드 회귀 없음.
- ⚠️ 인메모리 보관(세션 한정). client 모드 charset처럼 팝업 결과는 대상/콜백이 `window.opener.postMessage` 해야 구조화 값 수신(아니면 창 닫힘만 감지).

### (대체됨) 게이트웨이 콜백 URL — 결제/인증 리다이렉트 결과 캡처 (`{{ __callbackUrl }}`)
결제/인증 게이트웨이는 폼에 **콜백(리턴) URL**을 받아, 처리 후 그 URL로 **결과 파라미터를 실어 리다이렉트**한다(이니시스/나이스페이/KCP 등은 대개 merchant returnUrl로 **POST 자동전송**). 그 결과를 워크플로로 되먹인다. **널 두세명(프론트-수신/백엔드-엔드포인트/PG-호환)으로 나눠 설계 토론** 후 합성한 결론을 구현.
- **자동 발급 + 사용자 필드명 매핑**: `{{ __callbackUrl }}`(특수 토큰)을 게이트웨이가 요구하는 **필드명(returnUrl/ret_url/ReturnURL 등)** 의 폼 데이터 값으로 넣으면, 실행 시 서버가 **추측 불가능한 토큰 URL**(`{base}/api/v1/executions/callback/{token}`)로 치환. 필드명은 게이트웨이마다 달라 하드코딩 대신 폼 행으로 매핑(신규 GraphNode 필드 없음). PropertyPanel wait 섹션에 복사/삽입 버튼 + 안내.
- **수신 엔드포인트(백엔드, 신규)**: [ExecutionController](backend/src/main/java/com/flowlink/execution/ExecutionController.java) `@RequestMapping(GET+POST) /executions/callback/{token}`. `request.getParameterMap()`으로 **쿼리(GET)·폼바디(POST 자동전송) 모두** 병합 수신 → 파라미터를 재개 상태에 저장(authoritative) → **브리지 HTML**(text/html) 반환. 브리지가 `window.opener.postMessage({__flcallback:true, ...params})` + `window.close()`.
- **기존 재개 루프 재사용(제로 변경)**: 리다이렉트 후 팝업이 **우리 오리진**으로 돌아오므로 기존 [FormPopupDialog](frontend/src/components/FormPopupDialog.tsx)의 `message`(`e.source===popup`) 핸들러가 그대로 수신 → 기존 `resume({formValues})` 경로로 재개. `__flcallback` 마커는 제거 후 전달.
- **방어적 폴백**: postMessage 유실/차단 시에도, 게이트웨이가 이미 콜백을 때린 순간 백엔드에 결과가 저장됨 → **WAIT 재개 시 formValues가 비면 저장된 콜백 파라미터를 노드 출력으로**(`FlowExecutor.resume`). 
- **필터링 안 함**: 선언 `outputs`는 바인딩 픽커 칩만 구동. PG가 주는 **모든** 파라미터(resultCode/tid/authToken/MOID…)를 노드 출력 맵으로 → 선언 안 한 키도 `{{ key@노드 }}`로 바인딩(HTTP `body` 수동바인딩 패턴과 동일).
- **토큰 기반 테넌트**: 인증 없는(permitAll) 엔드포인트라 JWT 없음 → `callbackTokens`(token→execId) 역인덱스로 실행/테넌트 복원, `recordCallback`이 `TenantContext`를 수동 set/clear(try-finally). SecurityConfig `PUBLIC_PATHS`에 `/api/v1/executions/callback/**` 추가.
- 설정: `flowlink.execution.callback.base-url`(기본 `http://localhost:18080`). 외부 게이트웨이는 override(터널) 필요.
- 백엔드 변경: `ExecutionProperties.Callback`, `FlowExecutor`(RunState `callbackToken/Url/Params` + `{{ __callbackUrl }}` 치환 + `recordCallback` + WAIT 폴백), `PendingForm.callbackToken`(서버 내부, DTO 미노출), `ExecutionService`(콜백 토큰 레지스트리 + `recordCallback` + 파라미터 평탄화=parseForm 중복키 규약).
- 검증: H2 e2e — (A) 게이트웨이 POST 콜백→브리지 HTML(마커+파라미터)→**빈 formValues 폴백**으로 모든 콜백 파라미터가 노드 출력, (B) 명시 formValues 정상 경로+실행마다 새 토큰, (C) 콜백 미사용 일반 폼 무회귀, (D) **팝업 닫힘 신호 `{closed:true}`도 저장된 콜백 파라미터로 폴백**(센티넬 미유출) — 모두 PASS.
- **적대적 멀티에이전트 리뷰(6건 확정) 반영**: (1)(3) 팝업 닫힘 `{closed:true}`는 non-empty라 기존 `isEmpty()` 폴백을 못 타 콜백 결과가 유실되던 버그 → `isNoFormInput`(빈 값 또는 `{closed:true}`만)로 판정해 authoritative 콜백 파라미터 우선. (2) 콜백 스레드(`recordCallback`)와 재개 스레드(`resume`)가 `RunState`를 비동기화로 접근하던 데이터 레이스 → `synchronized(st)` 로 `callbackParams` 쓰기/읽기 happens-before. (4) `FormPopupDialog.onMsg` 가 `e.source===popup` 만 검사해 게이트웨이 페이지 SDK/애널리틱스의 임의 `postMessage` 로 조기 재개되던 문제 → **마커(`__flcallback`) 또는 동일 출처**만 인정(교차출처 잡음 거부, 브리지·커스텀 target 둘 다 보존). (5) `resume` 예외 경로에서 `callbackTokens` 토큰 미정리(누수) → catch 에서 정리. (6) 팝업 '다시 열기' 시 이전 리스너/타이머 누수 → `openPopup` 진입 시 이전 cleanup 선실행.
- ⚠️ **데모 범위**: 서명/해시 위변조 검증·본인인증 EncodeData 복호화·리플레이 방지(토큰 단일사용 외)·내구성 보관(인메모리 한계 상속)·외부 도달성(localhost는 동일 호스트 목 게이트웨이만, 실 게이트웨이는 base-url 터널)은 후속 과제. 실제 결제망용 하드닝 아님. POST charset이 비UTF-8(EUC-KR)이면 서블릿 디코딩 모지바케 가능(UTF-8 게이트웨이 무영향).

### [필드 ↔ Raw] 전환 범위 확대 — Params·Headers·폼 데이터(WAIT)
기존엔 HTTP **Body** 만 [필드↔Raw] 토글이 있었음. "raw로 볼 수 있는 건 왠만해서는 전환 가능하게, url encoding도" 요청 반영 → 키-값을 다루는 나머지 영역에도 동일 토글 추가([bodyConvert.ts](frontend/src/lib/bodyConvert.ts) 재사용).
- **HTTP Params(쿼리)**: `paramsRaw`/`rawParams`. Raw=urlencoded 원문(`a=1&b=2`). 백엔드 `build()`: `paramsRaw` 면 rawParams 를 토큰 치환 후 쿼리스트링으로 그대로 부착(인코딩은 사용자 책임 — 바디 urlencoded raw 와 동일 규약).
- **HTTP Headers**: `headersRaw`/`rawHeaders`. Raw=`Key: Value` 줄바꿈(curl 붙여넣기 형태). 백엔드: 각 줄 첫 `:` 로 분리, 값만 토큰 해석, 기존 `HEADER_NAME` 검증/`skipped` 재사용. 순수함수 `headersToRaw`/`rawToHeaders`(콜론 없는 줄이면 변환 실패=원문 보존) 신규.
- **폼 전송(WAIT) 폼 데이터**: body 슬롯을 안 쓰는 WAIT 노드라 `jsonRaw`/`rawBody` 재사용(urlencoded). 백엔드 `FlowExecutor` WAIT 브랜치가 `jsonRaw` 면 rawBody 를 `&`/`=` 로 분해해 팝업 폼 필드로. `{{ __callbackUrl }}` 치환·`referencesCallback` 도 rawBody(raw 모드) 검사하도록 확장.
- 전환은 비파괴적 양방향 변환(치환): 필드→Raw 는 직렬화, Raw→필드 는 파싱(실패 시 원문 유지 + 경고). 바인딩은 토큰으로 직렬화. `switchKvRaw`(params/headers)·`switchFormRaw`(WAIT) [PropertyPanel](frontend/src/panels/PropertyPanel.tsx).
- 검증: bodyConvert 단위(Node 타입스트리핑, 헤더+urlencoded 라운드트립) 13케이스 PASS. H2 e2e — (R1) HTTP raw params→쿼리·raw headers→요청헤더(server 모드), (R2) WAIT raw 폼(`a=1&b=2`)→팝업 필드 분해, (R3) WAIT raw 폼+`{{ __callbackUrl }}`+게이트웨이 콜백 폴백 — 모두 PASS. 콜백/폼 필드모드 무회귀 확인.
- ⚠️ Raw 모드 req: 스코프는 필드가 비어 파싱값이 안 실림(바디 raw 와 동일 한계). Headers Raw 값 토큰에 개행 포함 시 줄 분해가 먼저라 영향 없음. Params/폼 Raw 는 토큰 해석 결과에 `&`/`=` 가 섞이면 분해가 흐트러질 수 있음(엣지, 바디 raw 와 동일).

### (대체됨) 고정(사전등록) 콜백 + 상관키 + 서버 노티 (`{{ __notiUrl }}` · `{{ __corrId }}`)
동적 콜백(`{{ __callbackUrl }}`, per-run 토큰 URL + 브라우저 팝업 복귀)에 더해, **서버가 소유하는 고정 콜백 URL**을 추가. 게이트웨이 콘솔에 미리 등록하거나 **서버 간 노티(웹훅)** 로 쓴다. "URL 전달=둘 다 / 성공·실패=단일 콜백+응답예상값 선언(별도 URL 안 나눔)/때리는 주체=브라우저·노티 둘 다" 설계 토론 결론 반영.
- **고정 URL은 실행마다 안 바뀜 → 상관키로 매칭**: `{{ __corrId }}`(추측 불가 UUID)를 게이트웨이가 echo 하는 필드(oid/MOID 등)에 넣으면, 콜백이 그 값을 되돌려줄 때 서버가 **파라미터 값 스캔으로 대기 실행을 찾음**(필드명 무관 — `{{ __callbackUrl }}` 필드명 철학과 동일). 안정 URL은 `{{ __notiUrl }}`(= `{base}/api/v1/callbacks`, 폼에 실을 때) 또는 PropertyPanel 복사(콘솔 등록용).
- **서버 사이드 재개**: 고정 콜백은 브라우저가 없을 수 있어(순수 노티), 수신 엔드포인트 [ExecutionController](backend/src/main/java/com/flowlink/execution/ExecutionController.java) `@RequestMapping(GET+POST) /api/v1/callbacks` 가 `recordFixedCallback` → **서버가 직접 재개**(`doResume`). Accept 에 `text/html`(브라우저 팝업)이면 브리지 HTML, 아니면 게이트웨이용 `OK` 평문 ACK.
- **멱등 재개**: 팝업과 노티가 병행돼도 안전 — `resume()` 은 서스펜션이 없으면(이미 재개됨) 에러 대신 현재 상태 반환. 재개 로직은 `doResume` 로 공통화(브라우저 resume / 노티 공유).
- 백엔드: `FlowExecutor`(RunState `corrId/notiUrl` + `{{ __notiUrl }}`/`{{ __corrId }}` 치환 + `referencesToken` 일반화, `PendingForm.corrId`), `ExecutionService`(`corrIds` 역인덱스 + `recordFixedCallback`(값 스캔 매칭) + `doResume`/멱등 `resume` + `cleanupSuspension`), `SecurityConfig` `PUBLIC_PATHS` 에 `/api/v1/callbacks` 추가.
- 검증: H2 e2e — (F1) 서버 노티(브라우저 없이) 고정URL+corrId 매칭→서버 재개, 모든 파라미터→출력, `OK` ACK, (F2) 노티 완료 후 늦은 브라우저 resume 멱등(에러 없음), (F3) 브라우저가 고정URL 히트→브리지 HTML+재개, (F4) 미매칭 corrId→400 — 모두 PASS. 동적 콜백(A~D)·raw(R1~R3) 무회귀.
- ⚠️ **데모 한계 상속**: 인메모리 레지스트리(재시작 시 소실)·서명 위변조 미검증·상관키 단일 매칭(게이트웨이가 corrId 를 echo 안 하면 매칭 불가 — 대부분 merchant 파라미터 echo). 노티 ACK 는 평문 `OK`(PG 별 규격 상이 — 실연동 시 조정). base-url 은 `flowlink.execution.callback.base-url`(기본 localhost) override 필요.

---

## 최근 변경 (2026-07-05)

### 전체 Kotlin 이관 · TCP 노드 제거 · relay/mock 프로세스 백엔드 통합
- **백엔드 전체 Kotlin 이관**(Java 0): `src/main/kotlin`·`src/test/kotlin`만 존재. 스택 = Kotlin 1.9(Java 21 toolchain). 상세는 위 "백엔드 구조" 노트 + [docs/코틀린-이관-검토.md](docs/코틀린-이관-검토.md).
- **(2026-07-06 TCP 부활로 대체)** ~~TCP 노드 완전 제거~~: `TcpNodeExecutor`·`TcpField`/`TcpRespField`·고정길이 금융 전문(BAL1) 삭제. 노드 타입 = start/end/set/if/assert/http/form/wait/input/transform (TCP 없음). SSRF 가드도 HTTP 전용.
- **relay.js → 백엔드 통합**: 구 relay.js(:8787) 프로세스 폐기. `wait` 노드 콜백을 백엔드가 `/relay/{execId}/cb/{nodeId}`([RelayController](backend/src/main/kotlin/com/flowlink/execution/RelayController.kt))로 직접 받아 자동 재개하고, 타임아웃도 백엔드 스케줄러가 구동 → **브라우저 없이 wait 완결**. 별도 프로세스·:8787 없음.
- **mock-server.js → 내장 Mock 흡수**: 구 mock-server.js(:9090/:9091) 폐기. `demos/*.json` 은 내장 Mock(base `http://localhost:18080/mock/demo`)을 쓰고 `node demos/seed-mock.mjs` 로 라우트를 시드. demo-05(TCP)·`/openapi.json` 데모는 제외.
- **띄우는 프로세스 2개**: 백엔드(:18080) + 프론트(:5173). 콜백 데모만 `node demos/seed-mock.mjs` 1회로 mock 을 시드한다.

### 실행 경과 애니메이션 · respType=query · 인라인 토큰 칩 · 피커 칩 레이아웃
- **실행 경과 애니메이션(캔버스)**: 백엔드가 노드별 결과를 **노드 단위 짧은 트랜잭션으로 즉시 저장**하는 성질을 이용,
  실행 중 `GET /flows/{id}/runs?limit=1`(baseline id 비교로 방금 시작된 실행 발견) + `GET /executions/{id}` 폴링
  ([Editor.tsx](frontend/src/routes/Editor.tsx) `watchRunProgress`, 0.3~0.4초)으로 진행 상태를 받아
  [runProgress.ts](frontend/src/lib/runProgress.ts) `computeRunView` 가 노드/엣지 상태를 계산(editorStore.runView).
  - 표시: 지나간 엣지=녹색, 진행 중 노드 유입 엣지=**움직이는 점선**(RF `animated`), 노드 배지 ✓/✕/⊘/스피너+파란 펄스,
    실패 엣지=빨강, 건너뜀 노드 반투명. 결과 표시는 다음 실행/그래프 로드까지 유지.
  - "현재 실행 중" 노드는 서버가 pending 을 안 주는 동기 구간에선 **Kahn 위상정렬 미러**로 추정(성공한 상위에서 활성화됐지만
    기록이 없는 첫 노드). IF 분기는 기록된 `output.branch` 와 `fromPort` 매칭. pending(client/form/wait/input)은 서버 값 그대로.
  - 폴링 실패는 애니메이션 저하일 뿐(실행 루프 결과 반영이 항상 우선). 늦은 스냅샷은 `finishedAt` 가드로 무시,
    watcher 의 setExecution 은 pending 필드를 보존 병합.
- **respType=`query`**: 응답 본문이 URL(`…?code=0000&tid=T1`)/쿼리스트링일 때 `?` 뒤 파라미터를 키-값으로
  ([HttpNodeExecutor](backend/src/main/kotlin/com/flowlink/execution/engine/HttpNodeExecutor.kt) `parseQuery`/`extractQueryString`).
  프래그먼트(`#…`) 제거, `?` 없으면 **한 줄** `a=1&b=2` 형태만 인정(여러 줄 텍스트 오인 방지), 파라미터 없으면 `body` 보존.
  퍼센트 디코딩·중복키 리스트는 `parseForm` 규약. 위 respType 표 참조. 단위테스트 `HttpQueryResponseTest`.
- **인라인 토큰 칩([TokenInput](frontend/src/binding/TokenInput.tsx))**: `{{ key@노드 }}` 토큰이 입력창 **안에서 블럭(칩)**으로
  보이고 텍스트와 자유롭게 혼합(`/orders/` + [칩] + `/detail`). 저장 포맷은 토큰 포함 **순수 문자열**(칩=렌더링) → 백엔드 무변경.
  적용: HTTP baseUrl/Path·if/assert 조건식·form 열기 URL·transform 입력·SET 변수(비시크릿)·KeyValueEditor 값.
  - contentEditable **비제어**: 부모 value 가 밖에서 바뀔 때만 DOM 재구성(IME 한글 조합 보존), onChange 는 ref 로 최신 참조(stale closure 방지).
  - Chromium 이 trailing non-editable 뒤에 캐럿을 못 두는 문제 → 칩 앞뒤 **제로폭 공백(U+200B)** 패딩(직렬화 시 제거) +
    칩 몸통 클릭=캐럿을 칩 뒤로. 붙여넣기는 평문 강제+토큰 즉시 칩화, 손으로 친 `{{…}}` 는 blur 시 칩으로 정돈.
  - 구(舊) `bound` 저장 그래프: 칩으로 **표시**되고, 수정하는 순간 `{value: 토큰문자열, bound: null}` 로 이관(표시만으론 미변경).
    ⚠ JSON 바디에서 bound 는 네이티브 값(객체 등)이었는데 토큰 문자열은 문자열화 — 타입 유지가 필요하면 값 타입(select)로 코어션.
    SET 시크릿 행은 마스킹 유지를 위해 기존 [password + { } 바인딩 칩] 방식 유지.
  - **백엔드 보강**: [FlowExecutor](backend/src/main/kotlin/com/flowlink/execution/engine/FlowExecutor.kt) `setNode` 가 리터럴
    변수값도 `{{토큰}}` 해석. **값이 정확히 토큰 하나면 원형(숫자/불리언/객체) 보존**(`TokenResolver.resolveLiteral` —
    구 bound 와 동일 의미라 이관해도 다운스트림 조건식/JSON 타입 무변화), 텍스트 혼합이면 문자열 치환, 토큰 없으면 원문 그대로.
    HTTP 필드 리터럴(`fieldValue`)도 같은 규칙. Raw 텍스트영역(rawBody/rawParams/rawHeaders)은 "원문 보기"가
    목적이라 칩 없이 기존 [{ } 데이터 삽입] 버튼 유지.
  - 토큰 sourceId 클래스 `[A-Za-z0-9]` → **`[\w-]`** 로 확장(백엔드 TOKEN·프론트 tokenGrammar 미러) — 가져온/손편집
    그래프의 kebab/snake 노드 id(`node-1`)도 bound→토큰 이관 후 바인딩이 끊기지 않는다.
- **데이터 삽입 피커 칩 레이아웃**: [BindingPicker](frontend/src/binding/BindingPicker.tsx) 항목을 세로 목록 → **flex-wrap 칩 블럭**
  (응답=녹색점/요청=파란점 + 키 + 타입 배지, 노드 그룹핑 유지). 카드 폭 460→520.
- **폴더 기능 코틀린 이관 회귀 수정**: [FolderDtos](backend/src/main/kotlin/com/flowlink/folder/FolderDtos.kt) 의 요청 DTO
  (`FolderRequest`·`MoveFlowRequest`)에 남아 있던 `@get:JvmName` 이 jackson-module-kotlin 의 Creator 인식을 깨서
  **폴더 생성/이름변경/워크플로 폴더 이동이 전부 500**(HttpMessageNotReadableException) 이었음 — 어노테이션 제거로 복구.
  (위 "Jackson 역직렬화 대상에 @get:JvmName 금지" 규칙의 잔존 사례. 대시보드는 에러 토스트가 없어 조용히 실패로 보였음)
- **콜백 대기(wait) 프론트 대기 유지 버그 수정**: relay 백엔드 통합(SSE→폴링 전환) 때부터 `GET /executions/{id}` 가 대기 중에도
  `pending* = null` 을 반환 → 에디터 대기 루프가 **첫 재조회(1초) 만에 종료**돼 배너/카운트다운/펄스가 사라지고, 콜백이 와서
  백엔드가 완료시켜도 UI 에 안 보이던 문제("콜백 대기가 안 됨" 증상).
  [ExecutionService](backend/src/main/kotlin/com/flowlink/execution/ExecutionService.kt) `Suspended` 에 중단 시점 `Outcome`(pending 명세)을
  보관하고 `get()` 이 WAITING + 동일 테넌트면 pending 을 함께 반환 → 폴링만으로 대기 유지·재개 감지(연속 wait/client/input 체인 포함).
  부수 효과: 실행 경과 폴러 스냅샷에도 pending 이 실려 프론트 병합 로직 불필요(단순화).
- 검증: 백엔드 단위 5종 PASS + H2 API e2e 14(쿼리 파싱·퍼센트 디코딩·중복키·body 폴백·SET 토큰 치환·무회귀·실행 중 점진 기록) +
  브라우저(Playwright) e2e 12(칩 삽입·텍스트+칩+텍스트 직렬화·× 삭제·피커 칩·실행 중 점선/스피너·완료 배지·정지)
  + wait e2e 10(배너 3초+ 유지·펄스·유입 점선·수신 URL·콜백 자동 완료 표시·타임아웃 실패 표기·✕ 배지) PASS.
  프론트 tsc/vite/oxlint 통과. 적대적 멀티에이전트 리뷰 반영.
- **적대적 멀티에이전트 리뷰(73 에이전트: 4관점 파인더 23건 발견 → 발견별 3인 반박 투표, 15건 확정) 반영**:
  전체-토큰 원형 보존(위) · extractQueryString 여러 줄 오파싱 가드 + 해시 라우팅 URL(`#/cb?code=1`) 파라미터 보존 ·
  TokenInput 복사/잘라내기가 칩 라벨이 아닌 토큰 원문을 클립보드에 싣게(onCopy/onCut) · 드롭 삽입 차단 ·
  피커 복귀 시 입력 포커스 복원 · ZWSP 패드 자동 복구(ensurePads) · 토큰 문법 확장(key 에 한글, sourceId 에 `[\w-]`) ·
  **토큰화 불가능한 bound(공백/특수문자 키·이상 id)는 이관하지 않고 구조적 바인딩 칩 유지**(`isTokenizable` 가드 —
  이관하면 해석 불능 리터럴로 조용히 깨지는 회귀 방지) · reduced-motion 에서 무한 애니메이션 완전 정지
  (`animation-iteration-count:1`) · 피커 칩 응답/요청 텍스트 태그(색 단독 금지 1.4.1) · RunBadge role=img ·
  플로우 전환 시 이전 실행 상태 정리(가짜 running 방지) · WAITING 중 진행 폴러 1.5초 백오프(부하 중복 완화) ·
  wait 폴링 유지(위 버그 수정). 잔여 수용(문서화): baseline 동시 실행 오탐(단일 사용자 전제)·시크릿 전파 마스킹(후속).
- ⚠️ 실행 애니메이션은 폴링 기반(SSE/WebSocket 아님) — 초당 2~3회 GET. 같은 플로우를 다른 탭이 동시 실행하면 baseline 비교가
  다른 실행을 잡을 수 있음(단일 사용자 도구 전제). waitMsg·Raw 텍스트영역은 토큰이 평문으로 보임(의도).
  기존 그래프의 SET 리터럴에 문자 그대로 보관하던 `{{ ascii키 }}` 텍스트는 이제 치환됨(토큰 기능의 본질적 트레이드오프 —
  한글 키 등 비매치 텍스트는 원문 유지). 비시크릿 SET 변수 토큰이 상류 시크릿을 참조하면 평문으로 로그/DB 에 실림
  (bound 시절부터 동일 — 시크릿 전파 마스킹은 시크릿 볼트 과제와 함께 후속).

## 최근 변경 (2026-07-06)

### 토큰 입력 한 줄 고정 + 자세히 보기 · 폴더 중첩(트리) + 탐색기식 대시보드
- **TokenInput 한 줄 고정**: 값이 길어도 입력창이 여러 줄로 늘어나지 않는다 — `white-space: pre` + 가로 스크롤(가는 스크롤바)
  + 우측 페이드. 넘칠 때만 **⤢(자세히 보기)** 버튼이 나타나 다이얼로그(`variant="large"`, 줄바꿈 표시 허용·저장 값은 그대로 한 줄)
  로 크게 편집 — 다이얼로그 편집은 같은 value/onChange 라 인라인과 실시간 동기화, 그 안에서 { } 데이터 삽입도 동작
  (Esc 는 피커가 떠 있으면 피커부터 닫힘). 넘침 감지는 emit/재구성 + ResizeObserver(패널 리사이즈 대응).
- **폴더 중첩(이중·삼중·제한 없음)**: `Folder.parentId`(V5 마이그레이션, null=루트). 생성 시에만 상위 지정(이동 API 없음 →
  사이클 원천 불가), 상위는 테넌트 검증. **폴더 삭제 시 하위 폴더·워크플로는 한 단계 위로 승격**(루트 삭제면 미분류) —
  `FlowRepository.reassignFolder`. `FolderRequest.parentId`·`FolderSummary.parentId` 추가.
- **탐색기식 대시보드**([Dashboard](frontend/src/routes/Dashboard.tsx)): 현재 위치의 하위 폴더를 **큰 폴더 타일**(SVG 폴더 글리프
  + 워크플로/하위 폴더 수, 호버 시 ✎/×)로 그리드 표시 → 클릭해 들어간다. 폴더 안에서는 **브레드크럼(전체 › 부모 › 현재)** 으로
  위로 이동. "+ 새 폴더" 타일은 현재 폴더 안에 생성(사이드바 버튼은 루트 생성). 사이드바는 들여쓰기 트리(깊이 8단까지 들여쓰기,
  그 이상은 클램프). 카드 ⋯ 메뉴의 "폴더로 이동" select 는 트리 순서+들여쓰기(└) 라벨. 검색 중/미분류/선택 모드에선 타일 숨김.
- **탐색기 드래그&드롭 + 선택 활용**: 워크플로 카드를 **드래그해 폴더 타일/사이드바(미분류·폴더)/브레드크럼(전체·상위)에 드롭**
  하면 이동. 선택 모드에선 **선택된 카드를 끌면 선택 전체가 함께 이동**(탐색기 규칙)하고, 액션 바에 **"폴더로 이동…" 일괄 select** 추가.
  **폴더 타일 자체도 드래그해 다른 폴더/루트로 재배치** — 신규 `PUT /folders/{id}/parent`(`FolderService.move`,
  자기/자기 하위 아래로는 400 사이클 거부). 같은 창 드래그라 페이로드는 dataTransfer 대신 ref(`dragRef`)로 들고 다니며
  드래그오버 중에도 사이클 검증(불가 타깃은 하이라이트 안 됨). 드롭 가능 타깃은 점선 힌트, 드래그오버 시 강조.
- 검증: API(3단 중첩 생성·parentId 반영·삭제 시 상위 승격·재배치 사이클 400) + 브라우저 e2e 27(타일 진입·브레드크럼 이동·
  폴더 안 새 폴더·카드→타일 드래그·폴더 재배치 드래그·다중 선택 드래그·사이드바/브레드크럼 드롭·일괄 이동·
  한 줄 높이 유지·⤢ 다이얼로그 동기화) PASS, 기존 e2e 40(14+12+10+4) 무회귀.
- ⚠️ flowCount 는 직속 워크플로 수만(하위 합산 아님) — 후속. 사이드바 트리는 항상 펼침(접기 없음).
  드래그 이동은 데스크톱 전용(터치 미지원 — 카드 ⋯ 메뉴/일괄 select 로 대체 경로 있음).

### TCP 부활(노드+Mock) · 노드 복사/붙여넣기 · 홈=미분류 · 칩 고정폭
- **TCP 전문 노드 부활**: 코틀린 이관 때 제거했던 TCP 노드(9481019 역방향)를 복원 — `TcpNodeExecutor`(길이 프리픽스
  + 바이트 고정길이 필드 조립/슬라이싱, 인코딩 노드/필드별, `SsrfGuard.checkHostPort`), `NodeType.TCP`,
  GraphNode tcp 블록, 프론트 팔레트/PropertyPanel(값은 TokenInput 인라인 칩, 응답 필드명→outputs 자동 동기화),
  upstream 이 tcpResponse 필드명을 바인딩 소스로 노출. 리터럴 토큰은 `resolveLiteral` 규칙 공용.
- **내장 Mock 서버 TCP 지원**: spec `tcp` 섹션 — [TcpMockRegistry](backend/src/main/kotlin/com/flowlink/mock/TcpMockRegistry.kt)
  가 mock 저장/토글/삭제·앱 기동과 동기화해 ServerSocket 리스너를 열고 닫는다(포트 1024~65535, 바인딩 실패/충돌은
  저장 시 400 → 롤백). 규칙 = 디코딩 전문 contains 첫 매칭, 응답 템플릿 `{{req}}`(전문 에코)/`{{req:오프셋:길이}}`(바이트
  슬라이스). 프리픽스 규약이면 한 연결에 여러 전문. 편집기에 "TCP 전문 mock" 섹션. 단위테스트 `TcpMockTemplateTest`.
- **노드 복사/붙여넣기(Ctrl/Cmd+C·V)**: 캔버스 선택(Shift 박스/다중)을 localStorage 클립보드에 복사 — **A 워크플로에서
  B 워크플로로 붙여넣기 가능**. 붙여넣기는 새 id 부여 + 그룹 내 엣지 복제 + **복사 그룹 안을 가리키는 토큰/바인딩
  sourceId 재매핑**(editorStore.copySelection/pasteClipboard, remapNodeRefs) + 36px 오프셋 + 붙여넣은 것 선택.
  입력 필드/토큰 입력에 포커스가 있거나 텍스트 선택 중이면 브라우저 기본 복사에 양보. 탑바에 안내 배지.
- **대시보드 홈 = 미분류만**: 루트(홈)에서는 폴더 타일 + 미분류 워크플로만 보이고, 폴더 안 워크플로는 들어가야 보인다
  (탐색기 규칙). 사이드바 [전체 워크플로]+[미분류] 를 [홈] 하나로 통합(홈 드롭 = 미분류로 꺼내기), 검색 중엔 전체를 뒤진다.
- **폴더 안 복제 → 같은 폴더**: 카드 ⋯ 복제가 원본의 folderId 를 복제본에 승계.
- **에디터 ← / 뒤로가기 = 그 폴더로 복귀**: 대시보드 위치가 URL(`/flows?folder=id`)이 진실원 — 폴더 진입이 history 를
  쌓아 브라우저 뒤로가기로 상위 복귀, 에디터 ← 는 `FlowDetail.folderId`(신규)로 소속 폴더에 직행(미분류면 홈).
  삭제된 폴더 URL 은 홈으로 정리(replace).
- **토큰 칩 고정 폭(150px)**: 인라인 블럭이 내용(URI/노드명) 길이만큼 늘어나지 않는다 — 라벨 말줄임 + title 툴팁.
- **캔버스 노드 고정 폭(230px) + 그리드 스냅**: NodeCard/BranchNode 가 URL/이름 길이에 늘어나지 않고(말줄임),
  RF `snapToGrid`(22 — 배경 도트와 일치)로 드래그/팔레트 드롭이 그리드에 딱 맞는다. 붙여넣기 오프셋도 44(22×2).
- **캔버스 undo/redo(Ctrl+Z / Ctrl+Shift+Z·Ctrl+Y, 탑바 ↺↻)**: editorStore 에 스냅샷 스택(최대 100).
  드래그는 시작 시 1회 스냅샷(undo=드래그 전 위치), 속성 타이핑은 같은 노드 900ms 병합, 추가/삭제/연결/붙여넣기/
  가져오기 모두 대상. 입력 필드 포커스 중엔 브라우저 기본 undo 에 양보. 알려진 부채(Undo/Redo 없음) 해소.
- 검증: 백엔드 단위 6종(TcpMockTemplate 4 포함) PASS + TCP e2e 13(원시 소켓 프리픽스/에코·노드 슬라이싱·EUC-KR
  홍길동·IF 분기·기본 규칙·포트 충돌 400·토글/삭제 시 포트 닫힘) + 브라우저 e2e 14(박스선택 복사·같은/다른 플로우
  붙여넣기·토큰 재매핑 후 실행 성공·칩 150px·홈 미분류만·폴더 안 복제) + 캔버스 e2e 10(고정폭·좌표 22 배수·
  Ctrl+Z/Shift+Z·탑바 ↺↻·타이핑 병합 1회 undo) PASS, 기존 e2e 무회귀.
- ⚠️ TCP mock 은 HTTP mock 과 같은 테스트 도구 전제(무인증) — 리스너가 모든 인터페이스에 바인딩되므로 사내망 전제.
  노드 클립보드는 브라우저 localStorage(탭 간 공유, 서버 미저장).

## 최근 변경 (2026-07-08)

### 캔버스 주석 — 메모(스티키 노트) + 영역 박스(뒷배경 사각형)
"메모기능 + 표시용 영역표시 뒷 사각박스" 요청. 실행과 무관한 **주석 노드 2종**(팔레트 맨 아래 메모/영역 박스).
- **백엔드**: `NodeType.NOTE/GROUP` + `isAnnotation()` — [FlowExecutor](backend/src/main/kotlin/com/flowlink/execution/engine/FlowExecutor.kt)
  `newRun` 이 주석 노드를 위상정렬/활성화/기록에서 필터(연결 없어도 UNKNOWN 실패 없음, 실행 로그에 안 나옴).
  topoOrder/initialActive 는 `containsKey` 가드라 주석을 가리키는 손편집 엣지도 무해. **스키마 변경 없음** —
  주석 시각 필드(`noteText`/`noteColor`/`groupW`/`groupH`)는 GraphNode `ignoreUnknown` + raw 저장 라운드트립으로 보존.
- **메모(note)**: 220px 스티키 노트 — 본문 textarea 를 **노드 안에서 바로 입력**(`nodrag`, `field-sizing: content` 로
  내용만큼 성장). [NoteNode](frontend/src/canvas/NoteNode.tsx). 핸들(연결) 없음.
- **영역 박스(group)**: 노드들 **뒤**에 깔리는 반투명 점선 사각형([GroupNode](frontend/src/canvas/GroupNode.tsx)) —
  RF `zIndex:-1` + 본체 `pointer-events:none`(CSS `.react-flow__node-annogroup`)로 **안에 겹친 노드 클릭/드래그를
  통과**시키고, 제목바(`dragHandle:'.fl-group-drag'`)로만 이동/선택, 우하단 핸들로 크기 조절(포인터 캡처+줌 보정+
  그리드 22 스냅, 최소 110×66). RF 내장 'group'(parent) 타입과 충돌 피하려 RF 타입명은 `annogroup`.
- **공통**: 색 5종(노랑/파랑/분홍/초록/회색 — `nodeMeta.ANNO_COLORS`, 라이트/다크 겸용 반투명), PropertyPanel 에
  메모 내용·영역 크기(22 배수 스냅)·색 스와치. `graphAdapter.rfExtras()` 로 zIndex/dragHandle 을 노드 생성 4곳
  (toRF/addNode/addNodeFromTemplate/pasteClipboard)에 공용 적용. 복사/붙여넣기·undo/redo 그대로 동작.
- **오표시 방지**: [runProgress](frontend/src/lib/runProgress.ts) `computeRunView` 가 주석을 진행 추정에서 제외
  (진입차수 0 인데 기록이 영영 없어 "실행 중" 스피너로 오표시되던 케이스). 대시보드 미니어처(FlowStrip/FlowMini)도 주석 제외.
- 검증: 브라우저 e2e 20(로드/포인터 통과/영역 안 노드 클릭/인라인 입력/색 변경/제목바 선택/핸들 리사이즈 22 스냅/
  저장 라운드트립/실행 SUCCEEDED·주석 기록 0·배지 없음/Delete 키 안전/복붙) PASS + 기존 e2e 123 무회귀 + 백엔드 단위 6종 PASS.
- ⚠️ 영역 박스는 표시 전용 — 안의 노드를 묶어 함께 이동하는 컨테이너(RF parentId) 아님. 메모 본문 토큰 미해석(평문).

### 경로 스위치(SWITCH) 노드 — 선로 전환기
"A→B→C 를 스위치로 A→D→C 로 돌리는, 열차 선로 같은" 요청. **조건 평가 없이 사용자가 젖혀둔 트랙으로만 실행이 흐르는**
수동 라우팅 노드(2~6갈래). 테스트 중 mock 경로 ↔ 실제 경로 전환 같은 용도.
- **분기 메커니즘은 IF 와 동일 재사용**: `switchNode()` 가 `switchActive` 를 `NodeResult.withBranch(branch)` 로 기록 →
  `activateDownstream` 이 `fromPort==branch` 엣지만 활성화, 나머지 트랙 하류는 SKIPPED. 실행 애니메이션의 분기 매칭
  ([runProgress](frontend/src/lib/runProgress.ts))도 `nodeType if|switch` 로 확장만.
- **모델**: `GraphNode.switchActive`(백엔드가 읽는 유일한 필드) + `switchPorts[{id,label}]`(프론트 전용 — raw 라운드트립).
  엣지 `fromPort=트랙 id`. 트랙 없이 저장된 그래프는 기본 2트랙('1'/'2')·active '1' 폴백.
- **[SwitchNode](frontend/src/canvas/SwitchNode.tsx)**: 트랙 행마다 선로 모양(활성=진한 실선+▶, 비활성=점선) + 행별
  source 핸들. **캔버스에서 트랙 클릭 = 전환**(nodrag). 트랙 수 변경 시 `useUpdateNodeInternals` 로 핸들 재측정.
- **PropertyPanel**: 트랙 라디오(전환)·라벨 편집·추가(최대 6)/삭제(최소 2, **삭제 시 그 트랙 엣지도 제거** — 유령 선로 방지,
  활성 트랙 삭제면 첫 트랙으로 폴백).
- 검증: 브라우저+API e2e 19(젖힌 트랙만 실행·나머지 SKIPPED·3갈래·캔버스 클릭 전환·전환 후 재실행 경로 변경·
  트랙 추가/삭제/라벨·저장 라운드트립·엣지 정리) PASS + 기존 e2e 143 무회귀.
- ⚠️ 스위치는 수동 전환 전용(응답 값 기반 자동 분기는 IF). 트랙 전환은 그래프 수정(dirty) — 실행 전에 저장해야 반영.

## 참고 문서
- `backend/README.md` — Phase 1 구현 범위 표, API 요약, 실행 가이드
- `docs/` — UI/UX 멀티에이전트 설계 토론 로그, 엔터프라이즈 고도화 설계
