# FlowLink — 프로젝트 가이드 (유지보수용)

REST API 워크플로 오케스트레이션 플랫폼. 클라이언트 전용 프로토타입을
엔터프라이즈 플랫폼으로 고도화한 것. 백엔드/프론트 모두 **모듈러 모놀리스**(향후 워커 분리 대비
패키지 경계). UI 텍스트는 전부 한국어.

| | 스택 | 포트 |
|---|---|---|
| **Backend** | Spring Boot 3.3.5 / **Kotlin 1.9**(Java 21 toolchain) / JPA + Flyway / **Oracle**(기본, dev 는 H2 파일) / SpEL | 18080 |
| **Frontend** | React 19 / Vite 8 / @xyflow/react / Zustand / React Query / axios | 5173 |

---

## 실행 방법

### 앱 실행 — 리포 루트 `scripts/` (단일 jar, 화면+API 한 프로세스 :18080)
```bash
# Linux/macOS/Git Bash — 기본 프로파일 h2(로컬 파일 DB). 없으면 --build 로 빌드 후 실행.
bash scripts/start.sh            # (또는 --build)
bash scripts/status.sh           # PID 생존 + /actuator/health
bash scripts/stop.sh
```
```powershell
# Windows (PowerShell) — 같은 lifecycle
powershell -ExecutionPolicy Bypass -File scripts\start.ps1        # (또는 -Build)
powershell -ExecutionPolicy Bypass -File scripts\status.ps1
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
```
> ⚠️ 스크립트는 세트로 써야 한다(.sh 는 .sh 끼리, .ps1 은 .ps1 끼리) — .sh 는 Git Bash PID 를, .ps1 은 Windows PID 를 PID 파일에 쓰므로 섞으면 stop/status 가 서로의 프로세스를 못 찾는다.
- Swagger UI: `http://localhost:18080/swagger-ui.html`
- Health: `http://localhost:18080/actuator/health` · Prometheus: `/actuator/prometheus`
- DB 접속 override: `FLOWLINK_DB_URL`, `FLOWLINK_DB_USER`, `FLOWLINK_DB_PASSWORD` · 포트: `FLOWLINK_PORT`
- 프로파일/인증/Vault 는 env 로 주입(운영): `SPRING_PROFILES_ACTIVE=oracle`, `FLOWLINK_AUTH_GITHUB_ENABLED=true`, `FLOWLINK_VAULT_ENABLED=true` — 하단 "최근 변경 (2026-07-19)" 섹션 참조.
- **TLS 신뢰(사내 프록시)**: `start.ps1` 은 Windows 인증서 저장소를 신뢰(`-Djavax.net.ssl.trustStoreType=WINDOWS-ROOT`)해 사내 TLS 가로채기 프록시 뒤에서도 아웃바운드 TLS(AI/Copilot 등)가 된다(끄기 `FLOWLINK_WINROOT=0`). 추가 JVM 옵션은 `FLOWLINK_JAVA_OPTS`(Linux 는 커스텀 truststore 를 이걸로).
  - **최후수단 `FLOWLINK_TLS_INSECURE=true`**: 아웃바운드 TLS 인증서/호스트명 검증을 **전부 끈다**(모든 인증서 신뢰, [FlowlinkApplication.main](backend/src/main/kotlin/com/flowlink/FlowlinkApplication.kt) 이 빈 생성 전 기본 SSLContext 를 trust-all 로 교체). ⚠ MITM 취약 — 신뢰 가능한 사내망 전용, 기동 시 큰 WARN. 정석(WINDOWS-ROOT/CA 추가)이 안 될 때만.
- **H2 파일 위치**: 기본 `~/flowlink-h2db/flowlink.mv.db` (사용자 홈). 변경: `FLOWLINK_H2_FILE`. 초기화: 그 `.mv.db` 삭제.
- 백그라운드 PID/로그: 리포 루트 `.run/`(gitignore)
- **내부 서버 배포(단일 jar)**: `npm run build` → `gradle bootJar` 하면 **frontend/dist 가 flowlink.jar 에 동봉**되어
  내장 톰캣이 화면+API 를 :18080 한 프로세스로 서빙([SpaStaticConfig](backend/src/main/kotlin/com/flowlink/common/web/SpaStaticConfig.kt)
  — SPA fallback, api/mock/relay 제외). 앱은 도커에 안 올리고 서버(EC2)에서 scripts/ 로 실행. 절차: [infra/README.md](infra/README.md)

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
- 상세: [docs/superpowers/specs/2026-07-04-mock-server-builder-design.md](docs/superpowers/specs/2026-07-04-mock-server-builder-design.md).
- ⚠️ 상태 관리(부분취소 잔액 원장 등)는 범위 밖(범용 무상태 목) — 상태 있는 시뮬레이터가 필요하면 별도 프로세스로 세워 baseUrl 로 호출.

> ⚠️ **`demos/`·`e2e/`·구 `.github`/`flowlink-workflow` 스킬은 제거됨**(2026-07-19 정리). 데모 워크플로 시드/e2e 스크립트는
> 더 이상 리포에 없다 — 아래 "최근 변경" 섹션들에서 `demos/*.json`·`node e2e/*.mjs`·`node demos/seed-mock.mjs` 언급은 당시 기록(현재 파일 없음).

### 테스트
```powershell
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"
./gradlew test   # 백엔드 단위 테스트 전종 (DB 불필요, H2 인메모리)
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

### Gradle 멀티모듈 (2026-07-08 물리 모듈 분리 1단계 — 플러그인 SPI 경계)
```
backend/                루트 = Spring Boot 앱 (implementation(project(":transform-spi")))
 ├─ transform-spi/      변환 SPI(FlowTransform)만 담은 순수 모듈 — 앱·플러그인이 공유하는 계약(의존성 0)
 └─ plugin-sample/      참고용 변환 플러그인 — SPI compileOnly + plain JAR + ServiceLoader 등록
                        (mask 마스킹 · hmac-sha256 서명(멀티 출력 예시), 단위 테스트 포함)
```
- **새 플러그인 만들 때**: `plugin-sample/` 복사 → `settings.gradle.kts` include 추가 →
  `gradle :plugin-sample:jar` → `POST /api/v1/plugins` 업로드(즉시 reload) 또는 `:plugin-sample:deploy`(로컬
  `backend/plugins/` 배치, gitignore 됨). 상세 가이드: [plugin-sample/README.md](backend/plugin-sample/README.md).
- SPI 패키지(`com.flowlink.transform.FlowTransform`)는 모듈만 옮기고 FQCN 불변 — 기존 JAR 호환.
  id 가 내장과 겹치면 플러그인이 내장을 덮어쓴다(레지스트리 규약). 나머지 모듈 경계는 여전히 패키지로 표현.

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

## 이전 변경 (2026-06-29) — 콜백 초기 설계 3종 (relay 통합으로 폐기, 역사 기록)

> 결제/인증 콜백을 초기엔 세 방식으로 처리했다 — ① 팝업 폼전송(WAIT type) · ② per-run 토큰 URL `{{ __callbackUrl }}` · ③ 고정 URL+상관키 `{{ __notiUrl }}`/`{{ __corrId }}`.
> **2026-07-03 재설계로 전부 폐기**되고 `wait` 노드 + 백엔드 직접 수신(`/relay/{execId}/cb/{nodeId}`, [RelayController](backend/src/main/kotlin/com/flowlink/execution/RelayController.kt))으로 통합됐다.
> 이 토큰(`{{ __callbackUrl }}` 등)·엔드포인트(`/executions/callback/{token}`·`/api/v1/callbacks`)는 **현재 코드에 없다**(신규 작업 시 혼동 주의). 상세 역사: [form-wait-relay 설계 스펙](docs/superpowers/specs/2026-07-03-form-wait-relay-design.md).

### [필드 ↔ Raw] 전환 범위 확대 — Params·Headers·폼 데이터(WAIT)
기존엔 HTTP **Body** 만 [필드↔Raw] 토글이 있었음. "raw로 볼 수 있는 건 왠만해서는 전환 가능하게, url encoding도" 요청 반영 → 키-값을 다루는 나머지 영역에도 동일 토글 추가([bodyConvert.ts](frontend/src/lib/bodyConvert.ts) 재사용).
- **HTTP Params(쿼리)**: `paramsRaw`/`rawParams`. Raw=urlencoded 원문(`a=1&b=2`). 백엔드 `build()`: `paramsRaw` 면 rawParams 를 토큰 치환 후 쿼리스트링으로 그대로 부착(인코딩은 사용자 책임 — 바디 urlencoded raw 와 동일 규약).
- **HTTP Headers**: `headersRaw`/`rawHeaders`. Raw=`Key: Value` 줄바꿈(curl 붙여넣기 형태). 백엔드: 각 줄 첫 `:` 로 분리, 값만 토큰 해석, 기존 `HEADER_NAME` 검증/`skipped` 재사용. 순수함수 `headersToRaw`/`rawToHeaders`(콜론 없는 줄이면 변환 실패=원문 보존) 신규.
- **폼 전송(WAIT) 폼 데이터**: body 슬롯을 안 쓰는 WAIT 노드라 `jsonRaw`/`rawBody` 재사용(urlencoded). 백엔드 `FlowExecutor` WAIT 브랜치가 `jsonRaw` 면 rawBody 를 `&`/`=` 로 분해해 팝업 폼 필드로. `{{ __callbackUrl }}` 치환·`referencesCallback` 도 rawBody(raw 모드) 검사하도록 확장.
- 전환은 비파괴적 양방향 변환(치환): 필드→Raw 는 직렬화, Raw→필드 는 파싱(실패 시 원문 유지 + 경고). 바인딩은 토큰으로 직렬화. `switchKvRaw`(params/headers)·`switchFormRaw`(WAIT) [PropertyPanel](frontend/src/panels/PropertyPanel.tsx).
- 검증: bodyConvert 단위(Node 타입스트리핑, 헤더+urlencoded 라운드트립) 13케이스 PASS. H2 e2e — (R1) HTTP raw params→쿼리·raw headers→요청헤더(server 모드), (R2) WAIT raw 폼(`a=1&b=2`)→팝업 필드 분해, (R3) WAIT raw 폼+`{{ __callbackUrl }}`+게이트웨이 콜백 폴백 — 모두 PASS. 콜백/폼 필드모드 무회귀 확인.
- ⚠️ Raw 모드 req: 스코프는 필드가 비어 파싱값이 안 실림(바디 raw 와 동일 한계). Headers Raw 값 토큰에 개행 포함 시 줄 분해가 먼저라 영향 없음. Params/폼 Raw 는 토큰 해석 결과에 `&`/`=` 가 섞이면 분해가 흐트러질 수 있음(엣지, 바디 raw 와 동일).

## 최근 변경 (2026-07-05)

### 전체 Kotlin 이관 · TCP 노드 제거 · relay/mock 프로세스 백엔드 통합
- **백엔드 전체 Kotlin 이관**(Java 0): `src/main/kotlin`·`src/test/kotlin`만 존재. 스택 = Kotlin 1.9(Java 21 toolchain). 상세는 위 "백엔드 구조" 노트.
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

### 에디터 단축키 한/영(IME) 버그 수정 + Ctrl+S 저장
- **버그**: 한글 입력 모드에서 Ctrl+C/V/Z 를 누르면 `e.key` 가 `'ㅊ'`/`'ㅍ'`/`'ㅋ'` 로 보고돼 단축키가 전부 죽음
  ("복사 한 번 하고 나면(한글 입력 후) 다음 복사가 안 됨" 증상). → [Editor](frontend/src/routes/Editor.tsx) 키 핸들러를
  **물리 키 `e.code`(KeyC/KeyV/KeyZ/KeyY/KeyS) 기준**으로 판정(비QWERTY 배열 폴백으로 `e.key` 도 인정).
- **Ctrl+S 저장**: 저장 버튼과 동일 조건(dirty && !isPending)으로 저장하고 브라우저 "페이지 저장" 다이얼로그는 항상 차단.
  **입력 필드 포커스 중에도 동작**(복사/붙여넣기와 달리 입력 가드보다 먼저 처리). 핸들러([] deps)가 최신 뮤테이션을
  보도록 `saveShortcutRef` 로 연결.
- 검증: 재현+회귀 e2e 16(복사→붙여넣기→재복사 연쇄·입력/텍스트선택 잔류·한글 모드 C/V/S/Z·Ctrl+S dirty 저장·
  입력 중 저장) PASS, 단축키 관련 기존 스위트(copy/canvas/anno/switch/chips) 무회귀.

## 최근 변경 (2026-07-13)

### 콜백 수신 주소(relay base) — 화면 설정 + 접속 오리진 자동
"callbackUrl 설정하는 게 그냥 있으면, 기본은 어디서 받아오게" 요청. env 없이도 wait 콜백이 되도록 재설계.
- **[RelayBaseResolver](backend/src/main/kotlin/com/flowlink/settings/RelayBaseResolver.kt)** — 우선순위:
  ① 화면(⚙ 설정)에서 저장한 값(DB) → ② env/yml 명시값(`FLOWLINK_EXECUTION_RELAY_BASEURL`) → ③ **실행 요청의
  접속 오리진 자동**(브라우저가 접속한 그 주소가 곧 도달 가능한 서버 주소 — 서버는 `/relay/**` 를 항상 리슨하므로
  base 는 "밖에 알려줄 주소" 문자열일 뿐) → ④ localhost 폴백. `application.yml` 의 base-url 기본값을 비워
  ②를 "명시했을 때만"으로 만듦(`ExecutionProperties.Relay.configured`).
- **설정 저장소**: `AppSetting`(키-값, 테넌트 스코프, V6 마이그레이션·h2 는 ddl-auto) +
  [SettingsService](backend/src/main/kotlin/com/flowlink/settings/SettingsService.kt) ·
  `GET/PUT /api/v1/settings/relay`(value=저장값·effective=적용값·auto=접속 오리진, 빈 값 저장=삭제).
- **프론트**: 사이드바 하단 **⚙ 설정** → [SettingsDialog](frontend/src/components/SettingsDialog.tsx)
  (현재 적용값·자동값 표시, 저장/자동으로 되돌리기). wait 노드 속성의 수신 URL 패턴도 `{백엔드}` 대신
  실제 적용값으로 표시(PropertyPanel `WaitReceiveUrl` — settings 쿼리).
- `ExecutionService` 의 두 사용처(`start` 시드·`recordWaitCallback`)가 resolver 경유. 콜백 수신 스레드에선
  오리진 = 콜백이 실제로 때린 주소라 더 정확해진다.
- 검증: e2e 16(우선순위 매트릭스 env/저장/자동·삭제 복귀·DB 영속·자동 base 콜백 수신→재개·UI 저장/재열기/되돌리기)
  PASS + ui-wait 10·e2e 14·ui-e2e 12 무회귀. env 없이 기동한 jar 에서 콜백 완결 확인.
- ⚠️ ③은 실행을 시작한 요청의 오리진 기준 — 프록시 뒤에서 X-Forwarded 를 해석하려면 ForwardedHeaderFilter 후속.
  스케줄 실행(비요청 스레드) 도입 시엔 설정/env 필요(현재 MANUAL 만).

## 최근 변경 (2026-07-15) — SaaS 전환 P1: 인증·RBAC·테넌시 하드닝 (`saas-overhaul` 브랜치)

설계: [docs/superpowers/specs/2026-07-15-saas-overhaul-design.md](docs/superpowers/specs/2026-07-15-saas-overhaul-design.md) (4페이즈 — P1 인증·격리 / P2 내구 비동기 실행 / P3 presence / P4 Oracle·Compose).
- **RBAC(OIDC 모드에서만)**: [JwtRoleConverter](backend/src/main/kotlin/com/flowlink/security/JwtRoleConverter.kt) 가
  Keycloak `realm_access`/`resource_access` 롤 → `ROLE_*`. SecurityConfig URL 규칙: GET=인증만(viewer),
  쓰기=editor/admin, `/plugins/**`=platform-admin(전역), settings 쓰기=admin. **dev 모드(issuer 미설정)는 현행 그대로 permitAll**.
- **부트스트랩 API**: `GET /api/v1/auth/config`(public — enabled/issuer/clientId, 프론트가 env 없이 인증 모드 발견) ·
  `GET /api/v1/auth/me`(username/tenant/roles — dev 모드는 전권 가짜 사용자 "dev"). `Execution.triggeredBy` 에 사용자명 기록.
- **테넌트 구멍 수정**: `GET /flows/{id}/runs` 가 테넌트 미필터였음 → flow 소유 확인 선행.
- **mock slug 팀 스코프**: V7 마이그레이션 — 유니크가 (tenant_id, slug). 서빙 경로 `/mock/{tenant}/{slug}/**` +
  **레거시 `/mock/{slug}/**` 는 default 테넌트로 폴백**([MockPathResolver](backend/src/main/kotlin/com/flowlink/mock/MockPathResolver.kt),
  더 구체적인 쌍 매치 우선) — 기존 데이터·demos·seed 무변경 동작. ⚠ 기존 H2 파일 DB 엔 옛 전역 유니크 인덱스가 남음(ddl-auto 는 못 지움) — 팀별 동일 slug 를 dev 에서 쓰려면 `.mv.db` 초기화.
- **프론트 로그인**: oidc-client-ts PKCE([auth/](frontend/src/auth/)) — 부팅 시 `/auth/config` → enabled 면 자동 SSO 리다이렉트,
  `/auth/callback`(StrictMode 가드), axios 두 인스턴스에 Bearer+401 silent 갱신 인터셉터. `usePermissions()` 로
  viewer 읽기전용 게이팅(에디터 저장/실행/가져오기·대시보드/Mock 쓰기 UI·플러그인 업로드=platform-admin), 사이드바 사용자 칩.
- **저장 409 다이얼로그**([ConflictDialog](frontend/src/components/ConflictDialog.tsx)) + **미니 토스트**([components/toast.tsx](frontend/src/components/toast.tsx)) —
  onRun 무음 catch 제거, 플러그인 업로드 실패 표면화(알려진 부채 해소).
- **Keycloak dev 스택**: `docker compose -f deploy/keycloak-dev.compose.yml up -d`(realm 자동 import,
  [deploy/keycloak/flowlink-realm.json](deploy/keycloak/flowlink-realm.json)) → 백엔드 env
  `SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI=http://localhost:8081/realms/flowlink` 로 기동.
  테스트 유저(비번=아이디): alice(team-a admin+platform-admin)/bob(team-a editor)/carol(team-a viewer)/dave(team-b editor).
- 검증: 단위 8종(JwtRoleConverter 8·MockPathResolver 9 포함) + **OIDC e2e 27/27**(`node e2e/saas-p1-auth.mjs` —
  401/403 매트릭스·테넌트 격리·팀별 동일 slug·플러그인 게이트·triggeredBy) + 브라우저(SSO 리다이렉트·viewer 게이팅·사용자 칩)
  + dev 모드 무회귀(mock 레거시/테넌트 경로·seed). 프론트 tsc/build/oxlint 통과.
- ⚠ Keycloak 유저는 프로필 필수값(firstName/lastName/email) 없으면 password grant 가 "Account is not fully set up" 에러.

## 최근 변경 (2026-07-16) — SaaS 전환 P2: 내구 비동기 실행 (`saas-overhaul` 브랜치)

계획: [docs/superpowers/plans/2026-07-15-saas-p2-durable-exec.md](docs/superpowers/plans/2026-07-15-saas-p2-durable-exec.md).
"동기 실행 + 인메모리 suspension"(가장 큰 아키텍처 부채 2건)을 해소 — **실행은 워커 풀에서 비동기, 재개 상태는 DB 내구화(서버 재시작 생존)**.
- **RunState 스냅샷/rehydrate**: [RunStateSnapshot](backend/src/main/kotlin/com/flowlink/execution/engine/RunStateSnapshot.kt)
  (activeIds·ctx values/seeds(삽입 순서 보존 — nearest-upstream 의미 유지)·index·seq·pendingNodeId·pendingForm·relayBase/RunId) +
  `FlowExecutor.snapshot()/rehydrate()`(그래프는 flowVersionId 의 graphJson 에서 재구성). 값은 JSON 라운드트립이라
  숫자/불리언/객체 원형 보존(assert 숫자 비교 검증). ⚠ 스냅샷 시점 한정: **wait/input/form/client 중단 지점**(HTTP 응답 등 비직렬화 상태 없음).
- **suspension DB 내구화**: `execution_suspension` 테이블(V8 — execution_id PK·pending_node_id·run_state(암호문)·outcome_json·
  wait_deadline). run_state 는 **AES-GCM 암호화**([StateCrypto](backend/src/main/kotlin/com/flowlink/execution/engine/StateCrypto.kt) —
  키는 SHA-256(`flowlink.execution.state-secret`), **미설정 시 dev 폴백 키 + 기동 WARN**(운영에선 반드시 설정)) — ctx 에 시크릿/응답 본문이 실리므로.
  outcome_json 은 평문(pending 명세 — GET 폴링이 재시작 후에도 pendingWait 등을 반환하는 소스).
- **이중 재개 방지 CAS**: 재개 경쟁(콜백/타임아웃/수동 resume/⏹)은 전부 **suspension 행 조건부 DELETE(영향 행수 1=승자)** 로 판정
  ([ExecutionSuspensionRepository](backend/src/main/kotlin/com/flowlink/core/repository/ExecutionSuspensionRepository.kt)
  `deleteByExecutionIdAndPendingNodeId` in TransactionTemplate). 패자는 멱등 no-op(200 + 현재 상태). 인메모리 suspensions 맵은
  성능 캐시로만 남음(미스 시 DB 복호화 rehydrate).
- **비동기 실행**: `POST /runs`·`/resume` 은 **즉시 반환**(RUNNING), 본체는 전용 워커 풀("flowlink-exec",
  `flowlink.execution.worker.pool-size=8`/`queue-capacity=100`)에서 실행. 큐 포화는 **429**(TooManyRequestsException).
  워커 스레드는 TenantContext 수동 set/clear. relayBase 는 **요청 스레드에서 선캡처**(RelayBaseResolver 는 요청 컨텍스트 전용).
- **기동 복구**(`recoverOnStartup`): wait 데드라인 재무장(경과분은 즉시 발화=타임아웃 실패) + suspension 없는 RUNNING/WAITING 고아는
  FAILED("서버 재시작으로 중단된 실행") 로 정리.
- **프론트 실행 루프 = 폴링 드라이버**([Editor.tsx](frontend/src/routes/Editor.tsx) `onRun`): POST 후 RUNNING/WAITING 동안
  `GET /executions/{id}` 폴링(0.4초, wait 중 1초)하며 pendingInput/Form/Client 를 처리해 resume — 기존 watchRunProgress
  (baseline 발견 방식) 폴러는 제거(실행·애니메이션이 한 루프로 통합). 서버가 대기를 구동하므로 **탭을 닫아도 wait 콜백/타임아웃은 완결**.
- 검증: 단위 10종(RunStateSnapshotTest·StateCryptoTest 포함) PASS + **P2 e2e 22/22**(`node e2e/saas-p2-durable.mjs` —
  비동기 즉시 반환·wait 콜백 재개·**재시작 후 WAITING 유지→콜백→rehydrate 완주**·재시작 후 타임아웃 재무장·RUNNING 고아 FAILED·
  resume 멱등·input 재개·⏹ CANCELLED. 스크립트가 백엔드를 3회 재시작) + 브라우저(폴링 루프 대기 배너/카운트다운/수신 URL/콜백 자동 완료) PASS.
- ⚠ 스냅샷 암호키 미설정 시 dev 키(로컬 전용). 실행 이력의 대량 폴링은 여전히 GET(SSE 아님). 워커 풀은 단일 인스턴스 스코프 —
  수평 확장(공유 큐) 은 범위 밖. `Execution` 고아 정리는 기동 시 1회(주기 스윕 없음).

## 최근 변경 (2026-07-16) — SaaS 전환 P3: 실시간 협업 presence (`saas-overhaul` 브랜치)

계획: [docs/superpowers/plans/2026-07-16-saas-p3-presence.md](docs/superpowers/plans/2026-07-16-saas-p3-presence.md).
같은 워크플로를 연 사람들끼리 **커서·이름표·편집중 배지·저장 알림**이 실시간으로 보인다(공동 편집/CRDT 아님 — 그래프는 서로 불변).
- **백엔드 릴레이**: `spring-boot-starter-websocket` + raw `TextWebSocketHandler`(STOMP 미사용) —
  [PresenceHandler](backend/src/main/kotlin/com/flowlink/presence/PresenceHandler.kt) 가 방(flowId)별 참여자 최신 상태
  (커서/편집중)만 인메모리 보관, `hello`(입장 스냅샷)+`join/leave/cursor/editing/saved` 중계(보낸 사람 제외, 서버가 id·색 부여).
  동시 전송은 `ConcurrentWebSocketSessionDecorator`, 전송 실패 세션은 방에서 제거.
- **핸드셰이크 검증**([PresenceHandshakeInterceptor](backend/src/main/kotlin/com/flowlink/presence/PresenceHandshakeInterceptor.kt)):
  dev 모드=무인증(flowId UUID 검사 + 쿼리 `?name=`), OIDC 모드=쿼리 `?token=` JWT 검증(브라우저 WebSocket 은 Authorization
  헤더 불가) + **flow 테넌트 소유 확인**(교차 테넌트 훔쳐보기 차단), 이름은 `preferred_username`. SecurityConfig PUBLIC_PATHS
  `/ws/**`(자체 검증) + SpaStaticConfig fallback 제외 `ws/`.
- **프론트**: [lib/presence.ts](frontend/src/lib/presence.ts)(모듈 싱글턴 — 재접속 2초·커서 50ms 트레일링 쓰로틀) +
  별도 [presenceStore](frontend/src/store/presenceStore.ts)(**editorStore 오염 금지** — dirty/undo/selected 불변).
  렌더링은 xyflow v12 `ViewportPortal`([PresenceOverlay](frontend/src/canvas/PresenceOverlay.tsx) — flow 좌표라 팬/줌 자동 추종):
  원격 커서 SVG+이름표, 편집중 노드 색 링+`✎ 이름` 배지(선택=속성 패널 편집이라 editing 신호 하나로 통합). Editor 헤더
  아바타 스택([PresenceAvatars](frontend/src/components/PresenceAvatars.tsx)), `saved` 수신 시 토스트, 저장 성공 시 `sendSaved()`.
  이름: OIDC=`/me` username, dev=localStorage `fl:nick` 자동 생성(`게스트-xxxx`). vite proxy `/ws`(ws:true).
- 검증: 단위 11종(핸들러 6·인터셉터 5) PASS + **presence e2e 11/11**(`node e2e/saas-p3-presence.mjs` — 스냅샷/중계/본인 제외/
  늦은 입장자 상태/방 격리/퇴장/비 UUID 거절) + 브라우저 2탭(커서 좌표 정합·편집중 링·저장 토스트·아바타 join/leave·
  원격 이동이 로컬 그래프 불변·dirty 무영향). 프론트 tsc/build/oxlint 통과.
- ⚠ 방 상태 인메모리(서버 재시작 시 소실 — 클라 2초 재접속으로 복구, 수평 확장 시 sticky/공유 브로커 필요).
  OIDC 토큰이 쿼리스트링(사내 도구 전제 — 액세스 로그에 남을 수 있음). dev 모드는 두 탭이 같은 브라우저면 닉네임 공유(`fl:nick`).
  토큰 만료 후 재접속은 현재 액세스 토큰 사용(silent renew 는 axios 인터셉터가 유지).

### 실시간 공동 편집(후속 추가) — presence 위에 그래프 스냅샷 중계
설계 스펙에선 CRDT 공동편집을 범위 밖으로 뒀으나, 사용자 요청으로 **비CRDT(last-write-wins) 실시간 공동 편집**을 presence 위에 추가.
- **백엔드**: PresenceHandler 가 `t:"graph"` 메시지를 방에 **무상태 릴레이**(nodes/edges 페이로드 그대로, 서버는 그래프 미보관).
- **프론트** [lib/collab.ts](frontend/src/lib/collab.ts): editorStore 의 nodes/edges 변경을 구독해 **전체 그래프 스냅샷을 throttle(100ms)+서명 dedup** 으로 송신,
  원격 수신 시 [editorStore.applyRemoteGraph](frontend/src/store/editorStore.ts)(로컬 selectedId 하이라이트 보존·히스토리 미적재·에코 방지 플래그).
  **`dirty` 인 변경만 중계**(로드/초기화는 제외 — 새 접속자의 저장본 로드가 기존 참여자의 미저장 편집을 덮어쓰는 것 방지).
  → 노드 추가·이동·삭제·연결·**속성 편집**이 모든 참여자에게 실시간 반영(위치는 서명에 포함). 뷰포트(팬/줌)는 사용자별(비공유).
- 검증: 헤더리스 WS 릴레이(A→B 중계·본인 제외) + 브라우저 2탭 실측(메모 노드 추가·이동이 즉시 상대 화면에 반영, 편집중 링·dirty 동기화). 백엔드 presence 테스트 9종.
- ⚠ **last-write-wins**: 두 사람이 정확히 동시(같은 100ms 창)에 서로 다른 편집을 하면 마지막 스냅샷이 이김(드물게 발산 — 다음 편집/새로고침으로 수렴).
  진짜 충돌 병합(CRDT)은 아니다. 턴 주고받기·한 명 편집+관전 같은 일반 사용은 매끄럽다. 팀(테넌트) 스코프 flow 안에서만 공유(핸드셰이크 격리).

## 최근 변경 (2026-07-16) — SaaS 전환 P4: Oracle 지원 + Docker Compose 배포 (`saas-overhaul` 브랜치)

계획: [docs/superpowers/plans/2026-07-16-saas-p4-oracle-compose.md](docs/superpowers/plans/2026-07-16-saas-p4-oracle-compose.md).
`docker compose up` 한 번으로 **앱(Oracle 프로파일) + Oracle Free 23ai + Keycloak** 이 뜬다. 사내 Oracle 로는 `FLOWLINK_DB_URL` 만 교체.
- **Flyway vendor 분리**: 기존 V1~V8 → `db/migration/postgresql/`(체크섬 내용 기반 — 기존 PG DB 안전),
  Oracle 은 최종 상태 통합 [`db/migration/oracle/V1__init.sql`](backend/src/main/resources/db/migration/oracle/V1__init.sql)
  (uuid→varchar2(36)·text→clob·boolean→number(1)·timestamptz→timestamp with time zone·varchar 는 **char 단위**).
  `spring.flyway.locations: classpath:db/migration/{vendor}`. h2 프로파일은 flyway off 그대로(무영향).
- **oracle 프로파일**([application-oracle.yml](backend/src/main/resources/application-oracle.yml)): ojdbc11(runtime)+
  flyway-database-oracle, `hibernate.type.preferred_uuid_jdbc_type: CHAR`, **`ddl-auto: none`**(엔티티
  `columnDefinition="text"` 12곳이 Oracle validate 와 충돌 — Flyway 가 스키마 소유), ssrf allow-loopback(내장 mock 호출).
  Flyway 10.10 이 "Oracle 23 untested" WARN 을 내지만 마이그레이션 정상 적용 확인.
- **Compose**([deploy/docker-compose.yml](deploy/docker-compose.yml) + [deploy/Dockerfile](deploy/Dockerfile)):
  `oracle`(gvenzl/oracle-free:23-slim, APP_USER=flowlink, healthcheck) · `keycloak`(:8081, realm 자동 import,
  `KC_HOSTNAME` 고정+backchannel dynamic) · `app`(eclipse-temurin:21-jre + flowlink.jar). **issuer 이중 주소 해법**:
  `issuer-uri=localhost:8081`(토큰 iss 검증, 브라우저 관점)+`jwk-set-uri=keycloak:8080`(컨테이너 내부 도달) 분리.
  빌드는 호스트에서(npm build→bootJar) 후 `docker compose -f deploy/docker-compose.yml up -d --build`. 런북: [deploy/README.md](deploy/README.md) §0.5.
- **OIDC 모드 SPA 셸 401 버그 수정**: 단일 jar + OIDC 에서 `anyRequest().authenticated()` 가 index.html/assets 까지
  막아 **로그인 리다이렉트가 시작조차 못 하던** 문제(P1 은 vite dev(:5173) 로만 브라우저 검증해서 잠복) —
  SPA 셸 GET 경로(`/`·`/assets/**`·`/auth/callback`·화면 라우트)만 명시 permitAll(셸엔 비밀 없음, 데이터는 /api 게이트 뒤),
  catch-all 은 authenticated 유지.
- `demos/seed-mock.mjs` 에 `FLOWLINK_TOKEN` Bearer 지원(OIDC 스택용). `e2e/saas-p1-auth.mjs` 를 P2 비동기(폴링)·
  영속 DB 재실행(멱등 slug 정리)에 맞게 갱신.
- 검증(compose 스택): Flyway `Successfully applied 1 migration`(Oracle 23) → **RBAC/테넌시 e2e 27/27 on Oracle**(재실행 멱등) →
  wait 실행이 suspension(clob AES-GCM)→콜백 claim→rehydrate→SUCCEEDED(내장 mock HTTP 호출 포함) → 브라우저 :18080 접속 시
  Keycloak SSO 리다이렉트(PKCE)·`/auth/callback`/딥링크 200·h2-console 401. H2 dev 무회귀(단위 전부 PASS + 기동 확인).
- ⚠ Oracle 데이터는 `oracle-data` 볼륨(초기화 `down -v`). 첫 기동은 이미지 pull+DB 생성으로 수 분. compose 의
  state secret·비번은 데모값 — 운영 전 교체. Windows Docker Desktop 필요(데몬 미기동 시 compose 실패).

### 적대적 멀티에이전트 리뷰 반영 (SaaS 브랜치 P1~P4, 4관점 병렬 리뷰)
브랜치 전체를 보안·테넌시 / 실행 내구·동시성 / 프론트 / presence·배포 4관점으로 적대적 리뷰 → 확정 결함 수정:
- **보안**: `GET /api/v1/plugins` 가 매처 순서 때문에 viewer 도 조회 가능하던 구멍 → 플러그인 규칙을 GET 블랭킷보다 위로(platform-admin 전용, viewer/editor 403 확인).
- **실행 내구/동시성**: (1) claim CAS 가 파생 `deleteBy…`(SELECT 후 PK 삭제)라 경합 시 다음 대기 노드 행을 잘못 지우던 레이스 → `@Query` 단일 조건부 DELETE 로 원자화. (2) 재시작 후 rehydrate 실패가 행만 삭제하고 조용히 WAITING 방치 → FAILED 명시 마감. (3) persist 실패 시 인메모리 캐시 폴백(같은 인스턴스). (4) wait 타임아웃 재개를 단일 스케줄러 스레드 직접 실행 → 워커 풀 제출(head-of-line 차단 해소). (5) 워커 catch 를 Throwable 로(플러그인 JAR 의 Error 에 실행이 RUNNING 고착 방지). (6) 기동 시 suspension 행은 있으나 RUNNING 인 실행(행 commit·상태 save 사이 크래시)을 WAITING 으로 화해. (7) 노드 id 길이 검증(컬럼 초과 → 저장 시 거절) + Oracle `pending_node_id` char 단위.
- **프론트**: presence 옛 소켓의 늦은 onclose 가 새 세션 상태를 지우던 [H] 버그(reset 을 현재 소켓 가드 안으로) · 재접속 시 편집중 재announce · dev 닉네임 실동작 · **폴링 드라이버가 재시작 등 일시 GET 실패를 견디게**(P2 내구성 실효) · ⏹ 가 입력 모달을 즉시 중단 · 플로우 전환 시 낡은 실행이 새 화면 덧칠 방지.
- **presence 백엔드**: 전송 실패로 퇴출된 참여자도 leave 브로드캐스트(유령 아바타 방지) · 방 제거/합류 원자화(마지막 leave↔join 레이스) · 색 충돌 완화. keycloak `service_healthy` 게이트.
- **검증**: 백엔드 단위 **77종** PASS(presence 8 + **claim CAS `@DataJpaTest` 4종** 포함 — 조건부 삭제가 pending_node_id 일치 시만 삭제하고 PK-only 회귀를 잡음) + **P2 내구성 e2e 22/22**(자체 백엔드 3회 재시작 — 아래 재시작 hang 수정으로 신뢰성 회복) + **P1 RBAC e2e 27/27 on Oracle**(plugins GET 게이트 포함) + 프론트 tsc/build/oxlint.
- **후속 정리(리뷰 뒤)**: (B3 해소) compose 를 `.env`(`FLOWLINK_APP_ORIGIN`·`KC_PUBLIC_URL`)로 파라미터화 — realm import `${VAR:default}` 치환으로 공유 서버 배포 시 redirectUris·issuer·CORS 자동 정렬(기본 localhost 무회귀, 오버라이드·복귀 실측). P2 e2e 재시작 hang(execSync 손자 파이프 상속) → `stdio:'ignore'`+독립 헬스판정으로 22/22 완주. 이미 shipped 된 기능을 "후속 Phase"로 오도하던 stale 주석 3건(테넌트/내구성/플러그인 RBAC) 정정.
- **의식적 수용(문서화)**: (H4) 체인 wait 노드에서 외부 게이트웨이가 ACK 직후 다음 콜백을 쏘면 워커 큐 대기창과 경합 가능(테스트 도구·비동기 트레이드오프 — 필요 시 미매칭 콜백 버퍼링 후속). (L1) 워커 큐 포화 시 재개를 호출 스레드에서 수행(재개 입력 유실 방지 우선). presence 토큰은 쿼리스트링(사내 도구 전제, 로그 노출 가능). P3 2탭 렌더링 자동화(Playwright)는 미도입(프로토콜은 e2e·렌더링은 수동 검증).

## 최근 변경 (2026-07-17) — 실행 정확성 + 에디터 편의 기능 묶음
- **버그: 연결 안 된 노드 실행 수정(확정)** — [FlowExecutor](backend/src/main/kotlin/com/flowlink/execution/engine/FlowExecutor.kt) `initialActive` 가
  "진입차수 0" 인 모든 노드를 시작점으로 삼아, START 에 연결 안 된 떠 있는 노드가 멋대로 실행되던 문제. **오직 START 노드에서
  시작해 엣지를 따라 흐르게** 변경(도달 못 하는 노드는 SKIPPED). 1차 수정(30d6e42)은 START 없는 그래프에 진입차수 0 폴백을
  남겨 사용자 플로우(START 부재)에서 재현됐음 → **폴백 완전 제거**하고, START 가 없으면 `drive()` 가 "시작(START) 노드가
  필요합니다" 로 명확히 실패(f028f6c). 프론트는 **빈 새 플로우 로드 시 START 자동 배치**([editorStore](frontend/src/store/editorStore.ts) `loadGraph`)로 시작점을 보장. 재개 중엔 active 가 채워져 무해.
- **HTTP 상태코드 검증(400/404)** — [HttpNodeExecutor](backend/src/main/kotlin/com/flowlink/execution/engine/HttpNodeExecutor.kt) 가 응답 출력 맵에
  `httpStatus` 를 실어(server·client 모드) `{{ httpStatus@노드 }} == 200` / `!= 404` 로 검증(assert). 바인딩 picker([upstream.ts](frontend/src/binding/upstream.ts))·안내 노출.
- **단일 노드 독립 실행** — `POST /flows/{id}/nodes/{nodeId}/run`([ExecutionController](backend/src/main/kotlin/com/flowlink/execution/ExecutionController.kt))
  가 그 노드만 새 컨텍스트로 즉석 실행(이력 미저장, 상류 바인딩은 null). 대기/폼/입력/client 는 미지원(거절). 속성 패널 `▶ 이 노드만 실행` 버튼 + 결과 인라인(ok/httpStatus/output).
- **사이드바 접기** — 에디터 좌 팔레트·우 속성 패널을 접기 토글(» / «), 접으면 얇은 세로 바로. localStorage 지속.
- **속성 패널 오버레이** — 우 사이드바에 도킹 ↔ **캔버스 위 플로팅 오버레이**(⧉/→) 전환. 오버레이는 top-right 플로팅 카드([Editor](frontend/src/routes/Editor.tsx) `overlayCard`).
- **데이터 삽입 버튼 아이콘화** — raw 모드의 `{ } 데이터 삽입` 텍스트 버튼을 `{ }` 아이콘으로(TokenInput 인라인 버튼은 이미 아이콘).
- 검증: 백엔드 단위(presence 9 등) + 헤더리스 e2e(연결 안 된 노드 SKIPPED·httpStatus 출력·단일 실행 ok/status·assert httpStatus==200 SUCCEEDED) + 브라우저(단일 실행 인라인 결과·팔레트 접기·속성 오버레이) 실측. 프론트 tsc/build/oxlint.

### 에디터 편의기능 묶음(~20)
- **데이터 삽입 전면 아이콘화** — 모든 `{ }`/복사 버튼을 SVG 아이콘으로([components/icons.tsx](frontend/src/components/icons.tsx) DataInsertIcon·CopyIcon).
- **넓은 속성 모달** — 좁은 사이드 대신 `⤢` 로 중앙 넓은 모달(760px)에서 편집(Esc/배경 닫기·선택해제 시 자동닫힘).
- **도구 메뉴(⋯)** — 자동 정렬(위상 좌→우 `autoLayout`)·재실행·집중 모드(양 패널 접기)·노드 검색(Ctrl+F, 센터 이동)·그래프 JSON 보기+복사·자동 저장(dirty 후 1.5초 debounce)·패널 크기 리셋·단축키 도움말.
- **노드 조작** — 복제(Ctrl+D `duplicateSelection`)·우클릭 컨텍스트 메뉴(실행/복제/삭제).
- **캔버스 컨트롤** — 줌 100%·미니맵 토글·그리드 토글(localStorage). **헤더 노드 개수 배지**.
- **실행 로그** — 필터(전체/성공/실패/건너뜀)·요청/응답/출력 복사 버튼.
- 브라우저 실측: 도구 메뉴·JSON 모달·넓은 속성 모달·필터·미니맵/그리드 컨트롤·팔레트 접기·아이콘 전부 렌더 확인.

### 노드 생성 편의기능(빠른 추가)
"노드를 쉽게 만들 수 있게" 요청 반영. 팔레트 드래그/클릭 외에 위치 지정·연결 동시 생성 경로 추가.
- **캔버스 우클릭 / 빈 곳 더블클릭 → 노드 추가 검색 메뉴**([NodeAddMenu](frontend/src/canvas/NodeAddMenu.tsx)) — 클릭한 그 위치(`screenToFlowPosition`)에 배치. 검색 + Enter=첫 항목.
- **엣지를 빈 곳에 놓기 → 그 위치에 노드 추가 + 자동 연결**([FlowCanvas](frontend/src/canvas/FlowCanvas.tsx) `onConnectEnd` 의 `connectionState.isValid==false` 분기 → 메뉴, 고르면 `onConnect` 로 소스 핸들에 연결).
- **Ctrl/Cmd+K** — 화면 중앙 빠른 추가 메뉴.
- **팔레트 검색창 + 최근 사용 노드**([Palette](frontend/src/canvas/Palette.tsx) `q`/`recent`, `fl:palette:recent` localStorage 4개).
- **새(빈) 플로우 자동 START** — 위 실행 정확성 항목과 연동(시작점 보장).
- 브라우저 실측: 새 플로우 START 자동 배치·우클릭 메뉴로 HTTP 추가(노드 2)·START+떠있는 HTTP 실행 시 HTTP SKIPPED(전체 성공)·팔레트 검색.

### 색 배지·협업 커서 글자색 자동 대비(테마 가독성)
"커서 색이나 폰트색이 가끔 테마에 안 맞아 잘 안 보인다" 요청. 색 위 흰 글자가 특정 테마·색(초록/주황/청록/밝은 슬레이트)에서 대비 부족.
- **[lib/contrast.ts](frontend/src/lib/contrast.ts)** — WCAG 상대휘도로 배경색(hex 또는 `var(--x)` 테마변수)에 대비가 큰 전경색(흰/진한 글자)을 고르는
  `readableText`(순수) / `useReadableInk`(훅 — `applyTheme` 이 쏘는 window `fl-theme` 이벤트로 **테마 전환 시 재계산**).
- **적용**: 협업 커서 이름표·편집중 배지·참여자 아바타([PresenceOverlay](frontend/src/canvas/PresenceOverlay.tsx)·[PresenceAvatars](frontend/src/components/PresenceAvatars.tsx), peer 색은 concrete hex) ·
  HTTP 메서드 태그([MethodTag](frontend/src/components/MethodTag.tsx)) · 대시보드 미니 흐름 아이콘 칩([MiniFlow](frontend/src/components/MiniFlow.tsx) `CatIcon`) · Mock 배지 — 전부 `#fff` 고정 → 대비 기반 자동.
- **원격 커서 외곽선**: 고정 흰색 → 테마별 `--fl-cursor-halo`(라이트=진한/다크=흰, [index.css](frontend/src/index.css))로 캔버스 배경과 대비.
- ⚠ 브랜드 고정색 액션 버튼(실행/저장/중단, `--fl-ok/primary/fail`)은 "가끔 색이 바뀌는" 대상이 아니라 그대로 둠(항상 같은 색).
- 브라우저 실측: 라이트/다크 모두 GET 배지가 읽기 좋은 글자색, 테마 토글 시 즉시 재계산. tsc/build/oxlint 통과.

### 노드 편집 UI 컴팩트·통합 + 노드 바로가기 묶음(~20)
"URL 과 Path 를 굳이 나눌 필요 없다(안에서 `https://api.example.com/{{ otp@i1 }}/` 처럼 토큰) / 노드 바로가기 같은 느낌으로 / 합칠 수 있는 건 합치자" 요청.
**실행 모델(백엔드) 무변경 — 전부 프론트 UI 레이어 통합이라 기존 그래프 완전 호환.**
- **HTTP URL 통합**: Base URL + Path → **한 필드**([PropertyPanel](frontend/src/panels/PropertyPanel.tsx) `mergedUrl`/`setMergedUrl`). 백엔드는 여전히 `base+path` 이므로 전체를 `baseUrl` 로 쓰고 `path`는 빈다(무회귀·기존 분리 저장분은 병합 표시). **메서드를 URL 앞 인라인 셀렉트**(메서드 색 강조 `methodSel`). **문자셋·요청 방식(server/client)은 "고급" 접기**로.
- **cURL 상호변환**([lib/curl.ts](frontend/src/lib/curl.ts) — 순수): **cURL 붙여넣기**(`parseCurl` — `-X`/`-H`/`-d`계열/`-G`/`--url`/흔한 무해 플래그 → 메서드/URL/헤더/바디 채움) · **cURL 로 복사**(`toCurl` — 토큰은 그대로 = 실행 가능한 템플릿 스캐폴드).
- **URL `?쿼리` → Params 스마트 분리**(`extractQueryToParams`) · **Params/Headers/Body 탭 개수 배지**((2)/•).
- **노드 바로가기(navigation)**: 속성 패널 **연결 이웃 칩**(← 이전 / 다음 →) 클릭 → [editorStore](frontend/src/store/editorStore.ts) `focusNode` 신호 → [FlowCanvas](frontend/src/canvas/FlowCanvas.tsx) 가 `focusTick` 구독해 `setCenter`(선택+센터링). **토큰 칩 Alt/⌘+클릭 → 소스 노드로 이동**([TokenInput](frontend/src/binding/TokenInput.tsx)). Ctrl+F 노드 검색과 같은 어휘.
- **배선 가속**: 출력 키마다 `{{ key@id }}` **토큰 복사 버튼**(`OutputsEditor` `nodeId`) · 헤더의 **노드 id 복사**(`#id ⧉`).
- **TCP 대상**: 호스트+포트 → `host:port` 한 필드.
- **기타**: [KeyValueEditor](frontend/src/panels/KeyValueEditor.tsx) **행 복제(⧉)** · 속성 패널 **이 노드 복제/삭제** · 간격 축약 · 이름 빈칸=타입 라벨 placeholder · GET/HEAD 본문 안내.
- 브라우저 실측: cURL 붙여넣기로 POST/헤더2/JSON바디 채움 → `?src=web` 을 "쿼리 1개를 Params 로 분리" → 탭 배지(Params(1)/Headers(2)/Body•) · 바로가기 칩으로 START↔HTTP 이동+센터링. tsc/build/oxlint 통과.
- ⚠ cURL 복사는 토큰을 그대로 실어 그대로는 실행 불가(템플릿). 병합 URL 의 구(舊) 비토큰 `baseUrlBound` 는 레거시 칩+Path 유지.

### HTTP 요청 3파트 통합(섹션)+프리셋 · 미연결 노드 경고 · 노드별 입력 검증 (~20 UX)
"http 노드를 나누거나 간소화 / params·header·body 를 합쳐서 / 입력대기가 선이 안 이어졌는데 뜬다 / 사용자 친화적인 수정 20개" 요청.
**설계 결론(적대적 멀티에이전트 조사)**: HTTP 를 JSON/FORM 노드로 쪼개지 **않는다** — 단일 백엔드 `HttpNodeExecutor` 를 UI 만 갈라 팔레트·모델을 분열시키는 함정. 대신 한 노드에서 요청 3파트를 합쳐 보이고 프리셋으로 간소화. **전부 프론트 UI — 실행 모델 무변경, 기존 그래프 호환.**
- **요청 3파트 통합**: Params/Headers/Body **탭 → 항상 보이는 접이식 섹션**(쿼리(URL)/헤더/본문/응답, `HttpSection`). 한눈에 전체 요청. 섹션 기본 열림은 method/내용 기반(스마트).
- **프리셋(GET/JSON/Form/Raw)**: `applyPreset` 이 method+본문종류를 한 번에. 본문 종류 셀렉트 = JSON/Form/XML/Raw(**‘Form’=bodyType `urlencoded`**, 백엔드 동일 처리라 `form`↔`urlencoded` 통합·기존 저장분 라운드트립). **GET/HEAD 는 본문 섹션 자동 숨김**(백엔드가 무시 — 데이터는 비파괴 보존)+안내.
- **Content-Type 미리보기 칩**(`contentType` — build() 규칙 미러: bodyType→MIME, 명시 헤더 우선, 서버모드 비UTF-8 charset 부착), 노드 카드 **본문종류 배지**(JSON/FORM/XML/RAW).
- **‘이 응답에서 키 채우기’**(`populateOutputs` — ‘이 노드만 실행’ 응답의 키를 출력에 자동 추가·타입 추론) · **‘요청 미리보기’**(`previewText` — 보이는 것=보내는 것, 필드 쿼리는 URL 에 붙여 표기)+복사.
- **미연결 노드 경고**(입력대기 버그의 예방책): [lib/reachable.ts](frontend/src/lib/reachable.ts) `reachableFromStart`(+참조 캐시 `getReachableCached`). START 에서 도달 못 하는 실행 노드를 **캔버스 점선+‘⚠ 미연결’**([NodeCard](frontend/src/canvas/NodeCard.tsx))·**속성 패널 경고 배너**([PropertyPanel])로 **실행 전에** 표시.
- **노드별 입력 검증/도움**: 빈 URL/조건식/폼 URL/변환 미선택/입력 필드 없음 → 인라인 경고. IF/ASSERT **조건 빠른 삽입 칩**(`!= null`·`== 200`·`!= 404`·`== '0000'`·`== true`, `appendCond`).
- **입력대기 버그 조사 결론**: "선 안 이어진 input 노드가 실행 시 뜬다"는 **백엔드 `FlowExecutor.initialActive` 를 START 전용으로 고친 커밋(f028f6c) 이전 빌드**의 증상. 헤드리스 재현으로 현재 빌드는 floating input 이 **SKIPPED**(pendingInput=null) 확인 — 프론트는 서버 pendingInput 의 충실한 미러라 단독으로 못 띄운다. 위 미연결 표시는 재발 방지용.
- 검증: 브라우저 — 미연결 점선+배너, 프리셋 GET↔JSON(본문 섹션 등장·Content-Type 칩·노드 JSON 배지), 4개 섹션, 요청 미리보기(URL 병합 유지). tsc/build/oxlint 통과.

### 전 영역 UX 개선 묶음(~25) — 캔버스·노드·대시보드·실행·Mock (코드베이스 서베이 기반)
"유용/간소화 20개 리스트업 → 다 해줘(대시보드·Mock 포함)". 6관점 병렬 서베이(41후보)에서 추려 구현. 대부분 프론트, 대시보드 N+1 만 백엔드.
- **캔버스/편집**: 엣지 드래그 **재연결**(FlowCanvas `onReconnect`+[editorStore](frontend/src/store/editorStore.ts) `updateEdge`, sourceHandle 승계) · **중복 평행 엣지 방지**(`onConnect`/`updateEdge` dedup + `isValidConnection`) · 분기/스위치 엣지 **포트 칩(T/F·트랙)+클릭 전환**([DeletableEdge](frontend/src/canvas/DeletableEdge.tsx)) · **다중선택 정렬/분배 툴바**(`alignNodes`/`distributeNodes`) · **방향키 이동**(Shift=4칸)·**Ctrl+A**·**Esc 해제**·**? 도움말**(전역) · **문제 요약 배지**([lib/issues.ts](frontend/src/lib/issues.ts) `collectIssues` — 미연결·빈 필수값 → 클릭 시 `focusNode` 점프) · **선택영역 맞춤 줌**(⛶) · 노드 카드 `title` 툴팁.
- **노드 설정**([PropertyPanel](frontend/src/panels/PropertyPanel.tsx)): transform 재선택 시 **입력 바인딩 보존**(파괴적 리셋 제거) · SET 시크릿 **값 표시/숨김(👁)** · TCP 필드 **바이트 오프셋(@N)+총길이** · 목록 **행 순서 이동(▲▼)**(TCP/출력/입력, `moveInList`/`RowMove`) · input 안내메시지 `{ }` 삽입 · **데이터 삽입 피커 키보드 선택**([BindingPicker](frontend/src/binding/BindingPicker.tsx) ↑↓/Enter).
- **대시보드**([Dashboard](frontend/src/routes/Dashboard.tsx)): 카드 미리보기 **N+1 제거** — [FlowSummary](backend/src/main/kotlin/com/flowlink/definition/dto/FlowSummary.kt) 에 nodeCount/nodeTypes/**nodeText** 동봉([FlowService](backend/src/main/kotlin/com/flowlink/definition/FlowService.kt) `summaryOf` 가 현재 버전 그래프에서 서버측 1회 추출) → 카드가 `flow.nodeTypes` 로 그림 · **노드 내용 검색**(nodeText: 이름/URL/조건 등, 시크릿 값 제외) · **즐겨찾기(핀)**(localStorage, 홈 상단) · **이름 변경**(`PATCH /flows/{id}` `updateMeta`, 에디터 안 열고) · 폴더/삭제 다이얼로그([AskDialog](frontend/src/components/AskDialog.tsx) — `prompt`/`confirm` 제거).
- **실행 이력**([Executions](frontend/src/routes/Executions.tsx)): 행 클릭 → **과거 실행 상세 모달**(노드별 요청/응답/출력 재열람) · 상태 필터·검색. [RunPanel](frontend/src/panels/RunPanel.tsx): **실패 노드 자동 펼침** · 메서드 태그 정확화(requestText 파싱, 하드코딩 GET 버그) · **로그 내보내기(.txt)**.
- **Mock**([MockServerEditor](frontend/src/routes/MockServerEditor.tsx)): 라우트 **▶ 원클릭 테스트**(경로 파라미터 예시 채움, 인라인 결과) · 라우트/규칙 **복제** · **OpenAPI→라우트 자동 생성**(`openApiToMockRoutes`). [OpenApiImportDialog](frontend/src/openapi/OpenApiImportDialog.tsx): **URL 에서 가져오기**(fetch, CORS 안내).
- 검증: 프론트 tsc/build/oxlint · 백엔드 test 77 + compileKotlin 통과. 적대적 멀티에이전트 리뷰(3관점×검증) 반영.

## 최근 변경 (2026-07-18) — 실행 환경(env)·조건편집기 공용화·가져오기 통합 (사용자 친화 UX 선별 배치)
멀티에이전트 프로젝트 평가([docs/flowlink-user-critique.md](docs/flowlink-user-critique.md), 커밋 제외) 중 **UI/UX·간편함** 기준 항목을 선별해 구현.
- **실행 환경(dev/staging/prod) 전환 + `{{ 키@env }}`**: [lib/environments.ts](frontend/src/lib/environments.ts)(localStorage `fl:environments` — 활성 환경+변수, useSyncExternalStore) ·
  [EnvManagerDialog](frontend/src/components/EnvManagerDialog.tsx)(환경 CRUD·변수 편집)·[EnvSwitcher](frontend/src/components/EnvSwitcher.tsx)(에디터 상단 스위처, IssueBadge 옆). 실행 시
  활성 환경 변수를 `RunRequest.env`(신규 `JsonNode?`)로 전송 → [ExecutionService](backend/src/main/kotlin/com/flowlink/execution/ExecutionService.kt) `seedInput`→`seedScope` 로
  input/env 공통 시드(`ctx.putOutput("env", map)`). [upstream.ts](frontend/src/binding/upstream.ts) 가 활성 env 키를 바인딩 소스(`env`)로 노출 → `{{ 키@env }}` 칩.
  시드는 실행 시작 시점이라 **bare `{{ 키 }}` 는 상위 노드 우선, 없으면 env 폴백**(낮은 우선순위 기본값 — baseUrl/토큰을 노드마다 안 고치고 전환).
  [Editor.onRun](frontend/src/routes/Editor.tsx) 이 `activeEnvVars()` 를 실어 보냄. ⚠ env 값은 문자열 저장(비교는 `== '1500'`).
- **IF·ASSERT 조건식 공용 [ConditionEditor](frontend/src/panels/PropertyPanel.tsx)**: 두 노드가 쓰던 동일 SpEL 조건 UI(라벨·토큰입력·빠른삽입·빈조건 경고)를 한 컴포넌트로 통합(노드별 안내는 children).
- **응답타입 form/urlencoded 통합**: 드롭다운에서 `form` 제거(백엔드 파싱 동일) → `normRespType` 이 저장된 `form` 그래프를 `urlencoded` 로 표시(선택값 blank 방지), 동작·후방호환 불변.
- **가져오기 통합 [ImportDialog](frontend/src/openapi/ImportDialog.tsx)**: 진입점 2개(API 가져오기·가져오기)를 탭 하나로 — [워크플로 JSON | OpenAPI/Swagger | cURL].
  `OpenApiImportDialog`→`OpenApiImportBody`, `WorkflowIODialog` ImportTab→`WorkflowImportBody` 로 본문 추출(재사용). **cURL 탭**은 curl→HTTP 노드 하나 생성 후 `focusNode` 로 이동. "내보내기"(WorkflowIODialog export)는 유지.
- **실행 이력**([Executions](frontend/src/routes/Executions.tsx)): 행별 **↻ 재실행** + **더 보기**(50→200).
- 검증: 환경 e2e 6/6(명시@env·bare 폴백·문자열 비교·env 미전송 무회귀·상위 노드 우선순위, H2 새 jar 재확인) + 브라우저 실측(환경 생성/변수 편집/전환/삭제·가져오기 3탭·cURL→노드·콘솔 무에러) + 프론트 tsc/build/oxlint·백엔드 compileKotlin.
- **적대적 멀티에이전트 리뷰(4관점 파인더 → 발견별 반박 투표, 3건 확정) 반영**: (1)[medium] `VarEditor` 의 sig 재동기화가 **작성 중(빈 키) 변수 행을 조용히 버리던 유실 버그** →
  `key={환경}` 리마운트 + rows 를 로컬 source of truth 로(초기값만 initial prop). (2)[low] 키 전체 삭제(select-all)로 재명명 시 행+값 소실 — 같은 수정으로 해소.
  (3)[low] `BindingPicker` sources 가 env store 미구독이라 활성 env 변수 추가가 즉시 반영 안 되던 stale → PropertyPanel 이 `useEnvStore` 구독 + 활성 env 시그니처를 memo 입력에 포함.
- ⚠ 환경은 브라우저 localStorage 개인 스코프(팀 공유 아님·서버 미저장). cURL 복사는 토큰을 그대로 실어 그대로는 실행 불가(템플릿).

## 최근 변경 (2026-07-18) — 분석 문서 기반 기능 확장 배치(자동화·버저닝·시크릿·상태Mock 등)
멀티에이전트 평가([docs/flowlink-user-critique.md](docs/flowlink-user-critique.md), 커밋 제외)에서 **반박에서도 유지된 핵심 마찰**과 추가/정리 항목을 ROI 순으로 구현. 전부 헤드리스 e2e 44/44 검증([features-e2e 성격]).
- **버전 히스토리/복원**: `GET /flows/{id}/versions`·`GET .../versions/{no}`·`POST .../versions/{no}/restore`([FlowController](backend/src/main/kotlin/com/flowlink/definition/FlowController.kt)/[FlowService](backend/src/main/kotlin/com/flowlink/definition/FlowService.kt)).
  복원=그 스냅샷을 **새 버전으로**(불변 이력 유지). 도구(⋯) → 🕘 버전 기록 다이얼로그 + [graphDiff.ts](frontend/src/lib/graphDiff.ts)(노드/연결 added/removed/changed, 좌표 제외) 요약.
- **자동 실행 트리거(문서화 부채 해소 — MANUAL 만 동작 → 스케줄/웹훅)**: `trigger/` 모듈 — [FlowTrigger](backend/src/main/kotlin/com/flowlink/core/domain/FlowTrigger.kt)(V9 pg/oracle) +
  [TriggerService](backend/src/main/kotlin/com/flowlink/trigger/TriggerService.kt)(cron=Spring CronExpression 6필드·잘못된 식 400) + [TriggerScheduler](backend/src/main/kotlin/com/flowlink/trigger/TriggerScheduler.kt)(전용 20초 폴러 — `fireSchedule` 을 **프록시 경유**로 불러 @Transactional 적용) +
  [WebhookController](backend/src/main/kotlin/com/flowlink/trigger/WebhookController.kt)(`POST /hooks/{token}` 무인증·permitAll·전체 예외 가드). `ExecutionService.run(…, trigger)` 로 실행 종류 기록. 스케줄러/웹훅은 TenantContext 수동. P2 워커 풀 재사용이라 브라우저 없이 완결. 도구 → ⏰ 트리거 다이얼로그(cron 프리셋·다음실행·웹훅 URL 복사).
- **실행 이력 강화**: `GET /executions` 에 status/flowId/from/to(epoch ms)/offset([ExecutionRepository](backend/src/main/kotlin/com/flowlink/core/repository/ExecutionRepository.kt) `findFiltered` @Query, null 파라미터 무시) + `POST /executions/{id}/rerun`(원본 flowVersion+input 재현). Executions 화면 status/기간 서버 필터 + 재실행.
- **런타임 입력 파라미터**: [runInput.ts](frontend/src/lib/runInput.ts)(플로우별 localStorage) → onRun 이 `RunRequest.input` 로 주입(seedScope "input"). 도구 → ▶ 입력값과 실행. `{{ 키@input }}` 피커 노출. **실행 상세 응답 diff**([Executions](frontend/src/routes/Executions.tsx) '⇄ 이전 실행과 비교' — 노드별 변경/동일/신규).
- **테스트 스위트 일괄 실행**: `POST /api/v1/suites/run{folderId|flowIds}`([SuiteController](backend/src/main/kotlin/com/flowlink/suite/SuiteController.kt)) → 대시보드 '▶ 폴더/선택 실행' → [SuiteRunDialog](frontend/src/components/SuiteRunDialog.tsx) 성공/실패 매트릭스(각 실행 폴링).
- **실행 실패 알림**: [NotificationService](backend/src/main/kotlin/com/flowlink/notify/NotificationService.kt)(FAILED settle 시 비동기 파이어&포겟) → 테넌트 설정 웹훅(Slack/Teams `{text}`). `GET/PUT /api/v1/settings/notify`(admin), SettingsDialog 알림 필드. ⚠ admin 설정 URL 이라 스킴만 검증(전체 SsrfGuard 미적용).
- **시크릿 볼트(시크릿 전파 누수 부채 해소)**: [Secret](backend/src/main/kotlin/com/flowlink/core/domain/Secret.kt)(V10) + [SecretService](backend/src/main/kotlin/com/flowlink/secret/SecretService.kt)(StateCrypto AES-GCM 재사용·write-only). `{{ 이름@secret }}` 시드 + **캡처 로그 마스킹**(recorder 가 시크릿 값 문자열을 ••••••로, run·resume 양쪽). 도구 → 🔑 시크릿 볼트.
- **상태 있는 Mock**: `MockRule.setState`(응답 후 서버 상태 갱신) + `{{state.KEY}}`·조건 `source=state`([MockRuntime](backend/src/main/kotlin/com/flowlink/mock/MockRuntime.kt) 가 state 를 default emptyMap 로 스레딩 — 기존 호출/단위테스트 무변경, [MockGatewayController](backend/src/main/kotlin/com/flowlink/mock/MockGatewayController.kt) 서버별 상태맵). "1차 pending → 2차 approved" 시나리오. MockServerEditor 에 setState 편집.
- **정리/통합**: RunRequest 죽은 relayRunId/relayBase 제거. 공용 [Modal](frontend/src/components/Modal.tsx) 셸(신규 다이얼로그 이관) + [NodeExecutionLog](frontend/src/components/NodeExecutionLog.tsx)(RunPanel↔Executions 로그 블록 공용화 — 이력 모달도 복사 버튼).
- 검증: **features e2e 44/44**(버전 복원·필터/rerun·트리거(스케줄 폴러 실발화·웹훅)·시크릿 해석+마스킹·스위트 성공/실패·실패알림 앱 자체 웹훅 싱크로 전달 확인·상태Mock 1차/2차) + 백엔드 단위 전종 + tsc/build/oxlint. 적대적 멀티에이전트 리뷰 반영.
- ⚠ 단일 인스턴스 스코프(트리거 스케줄러·상태Mock·suspension 캐시 — 수평 확장 시 분산 락). 스케줄 실행은 요청 오리진 없어 relay base=설정/env/localhost. 시크릿 마스킹은 값 문자열 정확 일치(인코딩 변형은 후속). 트리거/스위트는 워커 큐 포화 시 429 상속.
- **미착수(의도적 연기)**: 대형 파일 물리 분리(PropertyPanel 1400줄·ExecutionService·FlowExecutor·editorStore·Editor·Dashboard·MockEditor·TokenInput → 분석 §8). 순수 유지보수 리팩토링이라 회귀 위험 대비 사용자 가치가 낮아 **개별 리뷰 PR로 분리 권장**(마라톤 일괄 분리는 지양).

## 최근 변경 (2026-07-18) — 시크릿 환경 스코프 · Mock 디벨롭 · TCP/콜백/폼 사용성 · 로그 가독성
사용자 요청 묶음("최근노드 제거·다크모드 실행로그 검은글자·시크릿볼트 환경·Mock 디벨롭·HTTP/TCP 분리·TCP/콜백/폼 사용성"). 에이전트로 영역을 나눠 병렬 설계 후 순차 구현.
- **실행로그 다크모드 검은글자(근본 수정)**: `<button>` 이 시스템색(ButtonText=검정)을 쓰고 색 상속을 안 해서 로그 행 버튼 글자가 검게 보이던 문제 → [index.css](frontend/src/index.css) 전역 `button { color: inherit }` + 로그 행 버튼 명시색. **팔레트 "최근" 섹션 제거**([Palette](frontend/src/canvas/Palette.tsx)).
- **시크릿 볼트 환경(env) 스코프**: [Secret.environment](backend/src/main/kotlin/com/flowlink/core/domain/Secret.kt)(V11 pg/oracle, `'*'`=공통) + (tenant,env,name) 유니크. 기동 시 레거시 NULL→'*' 백필([SecretService.backfillEnvironmentOnStartup](backend/src/main/kotlin/com/flowlink/secret/SecretService.kt) — H2 dev 관용). [activeSecrets(envName)](backend/src/main/kotlin/com/flowlink/secret/SecretService.kt)=공통 위에 활성 환경 이름단위 오버레이(같은 이름=환경값 승). `RunRequest.envName` 시드, 재개 마스킹은 시드된 secret 맵값(`secretValuesOf`)으로. 프론트: [SecretsDialog](frontend/src/components/SecretsDialog.tsx) 환경 셀렉트/배지, 실행 시 `activeEnvName()` 전송, 피커는 활성 환경에 적용될 시크릿만 노출. 기존 환경 스위처([environments.ts](frontend/src/lib/environments.ts) `{{키@env}}` 변수)와 같은 활성 환경을 공유. e2e 16/16.
- **Mock 디벨롭**: [MockRuntimeStore](backend/src/main/kotlin/com/flowlink/mock/MockRuntimeStore.kt)(서버별 인메모리 — seq/state/hits/journal) — **요청 기록**(`GET/DELETE /{id}/requests`), **상태 조회/리셋**(`GET /{id}/state`·`POST /{id}/reset`), **순차 응답**(`MockRule.repeat` — N회만 매칭 후 다음 규칙), **상태 산술**(`MockSetOp.op` incr/decr), **조건 연산자 확장**(gt/gte/lt/lte/regex/startswith/endswith). MockRuntime 순수성 유지(state/hits 파라미터 주입). MockServerEditor 에 런타임 패널(요청 로그·상태·리셋, 3초 폴링).
- **HTTP/TCP 팔레트 분리**: [nodeFactory](frontend/src/canvas/nodeFactory.ts) 그룹 — HTTP='API·REST', TCP='소켓·전문'(PALETTE_GROUPS). 실행 모델 무변경(단일 백엔드).
- **TCP 전문 미리보기(사용성 핵심)**: 전송 없이 요청 전문을 **바이트 단위로 조립**해 보여준다 — `POST /flows/{id}/nodes/{nodeId}/tcp-preview`(편집 중 노드 본문 실어 미저장 반영, 순수 계산이라 SSRF/네트워크 없음). [TcpNodeExecutor](backend/src/main/kotlin/com/flowlink/execution/engine/TcpNodeExecutor.kt) `build`/`execute` 분리 + `TcpPreview`(hex·필드 offset·✂절단·패딩·프리픽스). **EUC-KR 등 멀티바이트 길이 정확**(JS TextEncoder=UTF-8 전용이라 백엔드가 조립). PropertyPanel: 🔍 전문 미리보기(필드별 @offset·N/M바이트·절단/패딩 경고·hex/텍스트 복사), **+문자/+숫자 필드 프리셋**(문자=우측 공백·숫자=좌측 0 패딩 관례), NodeCard TCP 요약 배지(host:port·바이트).
- **콜백(대기)/폼 사용성**: 실행 중 대기 배너([RunPanel](frontend/src/panels/RunPanel.tsx))에 **🧪 테스트 콜백** — 외부 시스템 없이 수신 URL 로 샘플 콜백을 쏴 대기를 진행(수신 URL 경로만 뽑아 동일 오리진 POST). 대기 노드: **콜백 응답 프리셋**(OK/창닫기 HTML/JSON)·**cURL 예시 복사**. 폼 노드: 그래프의 콜백 대기 노드 수신 URL 을 **returnUrl 필드로 원클릭 삽입**(대기 노드 없으면 안내). [vite.config](frontend/vite.config.ts) 프록시에 `/relay`·`/mock` 추가(테스트 콜백·Mock 동일 오리진).
- 검증: 백엔드 단위 무회귀 + secret-env e2e 16/16 + tcp/callback e2e 12/12(미리보기 바이트/오프셋/절단/패딩/프리픽스/hex — 브라우저 실측 hex `30 30 31 32|C8 AB B1 E6|30 30 30 30 31 35 30 30` = "0012"+"홍길"(EUC-KR 절단)+"00001500" 일치 · 콜백 흐름 wait→테스트콜백→resume→SUCCEEDED) + tsc/build/oxlint.
- ⚠ TCP 미리보기 상류 바인딩은 빈 컨텍스트(리터럴/토큰만). 테스트 콜백은 대기 중(WAITING)에만 노출. 시크릿 환경 오버레이는 이름 단위(같은 이름 환경값이 공통 덮음). H2 dev 는 (tenant,env,name) DB 유니크 없음(앱 레벨 보장) — 운영 DB(Flyway)만 유니크 인덱스.

## 최근 변경 (2026-07-18) — 노드 고정 폭·접기 + AI 채팅 어시스턴트(자연어 → 플로우)
- **노드 고정 폭 + 접기/펴기**: 폭 230px 를 공유 상수 [NODE_W](frontend/src/canvas/nodeMeta.ts)로 통일(NodeCard·BranchNode·SwitchNode·FlowCanvas). 노드 헤더 셰브런(▾/▸)으로 상세행(HTTP/TCP 요약)+부라벨을 접어 캔버스 정리 — 핸들 유지(엣지 불변), 상태 `node.collapsed`(raw 그래프 라운드트립). 도구(⋯) '모두 접기/펴기'(주석 제외). [editorStore](frontend/src/store/editorStore.ts) `toggleNodeCollapse`/`setAllCollapsed`(dirty 표시·undo 미적재).
- **AI 채팅 어시스턴트(Copilot 스타일)**: 에디터 우측 ✨ AI 패널([AssistantPanel](frontend/src/components/AssistantPanel.tsx)) — 자연어로 플로우 생성/수정. 현재 캔버스(`getGraph()`)를 맥락으로 보내 제안 그래프를 받고 '캔버스에 적용'([importGraph](frontend/src/store/editorStore.ts), Ctrl+Z 되돌리기).
  - 백엔드 `com.flowlink.assistant`: `POST /api/v1/assistant/chat`([AssistantController](backend/src/main/kotlin/com/flowlink/assistant/AssistantController.kt)) → [AssistantService](backend/src/main/kotlin/com/flowlink/assistant/AssistantService.kt) 가 Claude(Anthropic Messages API) 호출. 시스템 프롬프트=[FlowSchemaPrompt](backend/src/main/kotlin/com/flowlink/assistant/FlowSchemaPrompt.kt)(노드 타입·엣지 `{from,to,fromPort}`·토큰 문법·레이아웃) + 현재 그래프. 응답 `{reply, graph}` 는 **균형 중괄호 스캐너**(문자열/이스케이프 인지)로 파싱. `GET /assistant/config`(stub/실제·모델).
  - **키 해석**: env `FLOWLINK_ASSISTANT_API_KEY`/yml → 시크릿 볼트 `anthropic-api-key`. 둘 다 없으면 **stub 모드**(키워드 기반 결정적 샘플: http/otp/결제/tcp) — 키 없이도 기능 완결. [AssistantProperties](backend/src/main/kotlin/com/flowlink/assistant/AssistantProperties.kt)(`flowlink.assistant.*`).
  - **하드닝**(적대적 리뷰 7건): LLM 컨텍스트로 보내기 전 **SET secret=true 변수 값 마스킹**(하드코딩 토큰은 감지 불가 → 시크릿 볼트 권장) · 동시 호출 **벌크헤드**(Semaphore, `max-concurrent`=4, 초과 429) · 적용 전 크래시 안전 검증([graphValidate](frontend/src/lib/graphValidate.ts), 수동 가져오기와 공용) · Enter 전송 **IME 가드**(한글 조합 중 오전송 방지) · 좁은 화면 자동 속성패널 접기 · 깨진 JSON 본문 400([GlobalExceptionHandler](backend/src/main/kotlin/com/flowlink/common/error/GlobalExceptionHandler.kt), 앱 전역). SsrfGuard 는 api.anthropic.com 통과. RBAC=editor 이상.
- 검증: 단위(AssistantJsonTest 6·백엔드 무회귀) + assistant e2e 21/21(config·인텐트별 그래프 유효성(START·엣지 포맷·IF포트)·제안 그래프 저장/실행 터미널 도달·멀티턴·깨진본문 400) + 브라우저 실측(✨열기→제안→적용 3→8노드 교체·노드 접기 85→39px·폭 230 고정) + tsc/build/oxlint.
- ⚠ 어시스턴트는 사용자 그래프를 외부 LLM(Anthropic)에 보냄(키 설정 시) — 시크릿 볼트 토큰은 이름만, SET 시크릿 값은 마스킹, 그 외 하드코딩 값은 그대로 전송(옵트인 전제). LLM 호출은 요청 스레드 동기(벌크헤드로 상한). 키 없으면 외부 호출 없음(stub 로컬).

## 최근 변경 (2026-07-18) — 어시스턴트: 프롬프트 라이브러리(awesome-copilot 식) + GitHub OAuth 팝업 로그인
> ⚠ 이 영역은 여러 번 재정의됐다(히스토리): HTTP 노드 OAuth2(폐기 e21c265) → 어시스턴트 OAuth(범용 provider) → **현재: GitHub 전용 팝업**. 스킬도 플로우 조각(폐기) → **현재: 프롬프트**. 아래가 최종.
- **스킬 = 재사용 프롬프트(awesome-copilot 스타일)**: 스킬은 **{name, description, prompt}**([Skill](backend/src/main/kotlin/com/flowlink/assistant/SkillDtos.kt)) — awesome-copilot.github.com 처럼 자주 쓰는 프롬프트를 저장. [SkillsDialog](frontend/src/components/SkillsDialog.tsx)(어시스턴트 💬) 라이브러리에서 **▶ 적용** 하면 그 프롬프트를 어시스턴트에 전송. **내장 스킬 없음**(사용자 정의). 프롬프트는 자동 주입 안 함(불러 씀) — **팀 지침(instructions)** 만 시스템 프롬프트에 자동 주입([SkillService.promptBlock](backend/src/main/kotlin/com/flowlink/assistant/SkillService.kt), admin). 저장은 설정 JSON(마이그레이션 없음 — AppSetting.value=text, H2 dev 는 [AppSettingSchemaFix](backend/src/main/kotlin/com/flowlink/settings/AppSettingSchemaFix.kt)로 CLOB 확장).
- **실제 GitHub Copilot 연결(디바이스 플로우 — VS Code Copilot 확장과 동일)**: 관리자 설정 없이(client_id 는 Copilot 공개값 고정) 사용자가 **Copilot 연결** 버튼 → [AssistantOAuthService](backend/src/main/kotlin/com/flowlink/assistant/AssistantOAuthService.kt) 가 `github.com/login/device/code` 로 디바이스 코드 발급 → 프론트가 코드 표시 + `github.com/login/device` 를 열어 사용자가 입력 → 백엔드 백그라운드 폴러가 토큰 취득·저장(AES-GCM). 채팅 시 GitHub 토큰 → **Copilot 토큰**(`api.github.com/copilot_internal/v2/token`, 캐시) → **Copilot API**(`api.githubcopilot.com/chat/completions`, `Editor-Version`/`Copilot-Integration-Id` 등 확장 헤더) 호출. [AssistantService](backend/src/main/kotlin/com/flowlink/assistant/AssistantService.kt) 포맷 분기: **Copilot→OpenAI 호환(Bearer)** / **api-key→Anthropic(x-api-key)**. 자격 우선순위 Copilot→key→stub.
  - API: `POST /device/start`·`GET /status`(connected/pending)·`POST /disconnect`(editor). 프론트: 디바이스 코드 카드(코드 복사·github 열기·완료 자동 감지 폴링).
- 검증: 백엔드 단위(AssistantFormat 5·포맷) + copilot-device e2e 12/12(**device/start=실제 GitHub 코드**·pending·disconnect·프롬프트 CRUD) + assistant 21/21·secret 16/16 무회귀 + 브라우저(Copilot 연결 버튼·디바이스 코드 카드·속성 빈상태 접기) + tsc/build/oxlint.
- ⚠ **Copilot 구독 필요**. `copilot_internal/v2/token`·`api.githubcopilot.com` 은 **비공식 내부 엔드포인트**(확장이 쓰는 것과 동일) — GitHub 이 바꾸면 헤더/URL(EDITOR_VERSION 등) 조정 필요. e2e 는 디바이스 코드 발급까지(실제 인증·Copilot 호출은 사용자 계정으로).
- **속성 패널 빈 상태 정리**: 노드 미선택 시 큰 안내문 대신 한 줄 + **접기 버튼**([PropertyPanel](frontend/src/panels/PropertyPanel.tsx) — 이전엔 접을 수 없었음). 어시스턴트 빈 화면 샘플 프롬프트 칩 제거(프롬프트는 💬 라이브러리).

## 최근 변경 (2026-07-19) — GitHub 로그인(Keycloak 대체) · deploy→infra 재편 · Vault 시크릿 · 리포 정리
"메인 앱은 도커 대신 서버(EC2)에서, 도커엔 Keycloak 말고 Vault, 로그인은 우리 Copilot GitHub 로그인으로, 안 쓰는 것 정리" 요청. **이 섹션이 배포/인증/시크릿의 현재 소스 오브 트루스 — 아래 P1(Keycloak)·P4(deploy compose) 섹션은 당시 기록(대체됨).**

### 앱 인증 = GitHub 로그인 (Keycloak/OIDC 대체)
- **동작**: `FLOWLINK_AUTH_GITHUB_ENABLED=true` 면 GitHub 계정(어시스턴트 Copilot 연결과 동일한 **디바이스 플로우**)으로 로그인 →
  앱이 **자체 JWT(HS256)** 를 발급하고 그 JWT 를 리소스 서버로 검증. 클레임 구조를 Keycloak JWT 와 동일하게
  (`preferred_username`·`tenant`·`realm_access.roles`) 맞춰 기존 [JwtRoleConverter](backend/src/main/kotlin/com/flowlink/security/JwtRoleConverter.kt)·
  TenantClaimFilter·[SecurityConfig](backend/src/main/kotlin/com/flowlink/security/SecurityConfig.kt) OIDC 브랜치를 **무변경 재사용**.
- **코드**: [AuthProperties](backend/src/main/kotlin/com/flowlink/security/AuthProperties.kt)(`flowlink.auth.*`) ·
  [AppJwt](backend/src/main/kotlin/com/flowlink/security/AppJwt.kt)(Nimbus HS256 발급 `issue()` + 검증 `decoder()`, 키=SHA-256(secret) 32B) ·
  [GithubAuthService](backend/src/main/kotlin/com/flowlink/security/GithubAuthService.kt)(device/code → 백그라운드 폴 → `api.github.com/user` → `allows()` 화이트리스트 → appJwt) ·
  [AuthConfig](backend/src/main/kotlin/com/flowlink/security/AuthConfig.kt)(`github-enabled=true` 일 때만 `JwtDecoder` 빈 등록 → 인증 브랜치 활성) ·
  [AuthController](backend/src/main/kotlin/com/flowlink/security/AuthController.kt)(`/auth/config` mode=github|none · `/me` · `/github/device/start` · `/github/device/poll`, 전자 3개 permitAll).
- **프론트**([auth/](frontend/src/auth/)): oidc-client-ts 제거 → localStorage 토큰([auth.ts](frontend/src/auth/auth.ts)) + [GitHubLogin](frontend/src/auth/GitHubLogin.tsx)(디바이스 코드 카드·폴링) +
  [AuthContext](frontend/src/auth/AuthContext.tsx) github 모드. axios Bearer + 401 시 토큰 폐기·재로그인. `usePermissions()` 게이팅 불변.
- **env**: `FLOWLINK_AUTH_GITHUB_ENABLED`(기본 false=dev permitAll). github-enabled=true 면 **서명 시크릿 필수**(없으면 공개 dev 키로 토큰 위조 → [GithubAuthStartupValidator](backend/src/main/kotlin/com/flowlink/security/AuthConfig.kt) 가 기동 실패). 서명 시크릿은 **로컬 env `FLOWLINK_AUTH_JWT_SECRET`, 운영 Vault**([AppJwt](backend/src/main/kotlin/com/flowlink/security/AppJwt.kt) 가 env 우선 → 없으면 Vault `flowlink-config` 경로 key `jwt-secret` — 워크플로에 미노출). `FLOWLINK_AUTH_ALLOWED_LOGINS` 는 **선택**(비우면 GitHub 인증한 누구나 로그인/전권 — 전체 허용, 기동 WARN).
  client_id 는 Copilot 공개 client 기본(`AuthProperties.clientId`). 표준 OIDC(Auth0/Entra 등)도 여전히 지원 — `application.yml` issuer-uri 설정 시 그쪽으로(IdP 비종속).
- 검증: 자체서명 HS256 토큰으로 `/me`·`/flows` 인증 통과·역할 매핑·위조서명 401·무토큰 401·실제 GitHub device 코드 발급·브라우저 로그인 화면 렌더.

### 배포 재편: `deploy/` → `infra/`, 앱은 도커 밖, Vault 인프라
- **메인 앱은 도커에 안 올린다** — 서버(EC2)에서 `scripts/start.sh`(위 실행 방법)로 단일 jar 실행. [infra/Dockerfile](infra/) 제거.
- **[infra/docker-compose.yml](infra/docker-compose.yml)** = 지원 인프라만: **Vault**(dev, KV v2, :8200) + **Oracle**(`--profile oracle`, 로컬 테스트용).
  Keycloak 서비스·realm·`keycloak-dev.compose.yml` 전부 제거. 앱 서비스도 제거. `docker compose -f infra/docker-compose.yml up -d`.
- **기본 DB = Oracle**(Postgres 지원 제거) — base `application.yml` 이 Oracle(ddl-auto none·uuid CHAR·flyway {vendor}=oracle·ssrf allow-loopback).
  구 `application-oracle.yml`·`db/migration/postgresql/`·PG 드라이버/flyway-pg/testcontainers-pg 제거. **로컬 dev 는 h2 프로파일**(scripts 기본).
  Oracle 로 기동: `SPRING_PROFILES_ACTIVE=oracle`(scripts h2 기본을 벗어나는 스위치 — 설정은 base) + `FLOWLINK_DB_URL`. 사내/별도 Oracle 로는 URL 만 교체(스키마는 Flyway `db/migration/oracle` 통합 V1+V9~V12 가 생성).
- [infra/README.md](infra/README.md)·`.env.example`·SERVER-DEVELOPMENT.md 를 새 구조로 재작성. 구 lifecycle(flowlink-start/stop·server-rebuild)은 `scripts/` 로 통합.

### HashiCorp Vault 시크릿 연동 (시크릿 볼트에 오버레이)
- **[VaultProperties](backend/src/main/kotlin/com/flowlink/secret/VaultProperties.kt)**(`flowlink.vault.*`: enabled/address/token/mount/path/**config-path**/refresh-seconds) +
  **[VaultSecretSource](backend/src/main/kotlin/com/flowlink/secret/VaultSecretSource.kt)**: `GET {addr}/v1/{mount}/data/{path}`(X-Vault-Token, KV v2 봉투 `data.data`) → 시크릿 맵. **경로별 TTL 캐시**(3초 타임아웃, 실패 시 이전 캐시 유지 → 무중단). `secrets()`=워크플로 경로, `appSecret(key)`=**config 경로**(앱 설정 비밀).
- **두 경로 분리**: (a) 워크플로 시크릿 `path`(기본 flowlink) → [SecretService](backend/src/main/kotlin/com/flowlink/secret/SecretService.kt) `activeSecrets` 가 **공통 기본층**으로 오버레이(우선순위: 활성환경 DB > 공통 DB > Vault), `listNames` 에 `source=vault`(읽기전용) 노출 → 피커/다이얼로그(`SecretView.source`, [SecretsDialog](frontend/src/components/SecretsDialog.tsx) `Vault` 배지). (b) 앱 설정 비밀 `config-path`(기본 flowlink-config) → **워크플로에 미노출**. 서명키 등 앱 내부 비밀을 바인딩과 분리.
- **jwt-secret 을 Vault 에서**: [AppJwt](backend/src/main/kotlin/com/flowlink/security/AppJwt.kt) 가 env `FLOWLINK_AUTH_JWT_SECRET`(로컬) **우선 → 없으면** `vault.appSecret("jwt-secret")`(config 경로, 운영). GithubAuthStartupValidator 는 [AppJwt.hasSecret](backend/src/main/kotlin/com/flowlink/security/AppJwt.kt)(env·Vault 어느 쪽이든)로 가드. 라이브 검증: config 경로에 jwt-secret 시드 → env 없이 github 모드 bootRun 기동 성공(health 200).
- 기본 비활성(무회귀). enabled=true(+token) 일 때만 조회. env: `FLOWLINK_VAULT_ENABLED`·`FLOWLINK_VAULT_ADDRESS`·`FLOWLINK_VAULT_TOKEN`·`FLOWLINK_VAULT_CONFIG_PATH`.
- 검증(라이브): Vault dev(도커)에 시크릿 시드 → 목록 `source=vault` → `{{ CLEANKEY@secret }}` 실행 SUCCEEDED(다운스트림 assert 비교까지 정확)·로그 마스킹(••••••)·원문 미노출·음성대조 FAILED. 백엔드 test 전종 PASS·프론트 tsc/build. 브라우저에서 `Vault` 배지·읽기전용 렌더 확인.

### 리포 정리 (test-as-you-go)
- 제거: `demos/`(데모 워크플로/seed) · `e2e/`(테스트 스크립트) · 구 `.github`/`flowlink-workflow` 스킬 · `backend/scripts`(구 backend 기동) · `legacy/`(동결 프로토타입) · docs 구 설계문서 5종(초기 Jul-10). 삭제 후 빌드/테스트 통과 확인.
- `scripts/`(리포 루트)에 앱 lifecycle 통합: `start`/`stop`/`status` × (`.sh` Linux·`.ps1` Windows). ⚠ 두 세트는 PID 파일 규약(Git Bash PID vs Windows PID)이 달라 섞어 쓰면 안 됨.
- 단일 프로세스 정리: 죽은 `flowlink.security.client-id`(구 OIDC PKCE 잔재) 제거. README(루트/frontend/backend/infra) 전면 재작성.
- ⚠ Vault dev 서버는 인메모리(재시작 시 초기화). GitHub 로그인 미설정 시 dev permitAll(로컬). 앱 JWT 시크릿·Vault 토큰은 운영 전 반드시 교체.

### 앱 GitHub 로그인 = Copilot 연결 통합 + 적대적 리뷰 반영
- **통합**: 앱 로그인과 어시스턴트 Copilot 연결이 같은 계정·client_id(Copilot 공개)·scope(read:user)라, 로그인 때 받은 GitHub 토큰을
  [GithubLoginEvent](backend/src/main/kotlin/com/flowlink/security/GithubLoginEvent.kt) 로 발행 → [AssistantOAuthService.onGithubLogin](backend/src/main/kotlin/com/flowlink/assistant/AssistantOAuthService.kt) 이
  어시스턴트 토큰 저장소(AES-GCM)에 넣어 **한 번 로그인 = 앱 접속 + Copilot 연결**. Copilot client 일 때만 채택, 폴 스레드에서 event.tenant 스코프 세팅/복원.
- **적대적 멀티에이전트 리뷰(4관점 → 발견별 검증, 7건 확정) 반영**:
  (1)[high] github-enabled + jwt-secret 미설정 → 공개 dev 키로 토큰 위조 → **fail-closed 기동 실패**(GithubAuthStartupValidator). (2)[high] 빈 allowed-logins → 누구나 admin: 초기엔 필수화했으나 **사용자 결정으로 선택 유지**(비면 전체 허용 + 기동 WARN) — jwt-secret 강제는 유지.
  (3)[med] 무인증 device/start 남용 → 폴러 스레드 폭주 → **동시 세션 상한(MAX_SESSIONS=20)**. (4)[med] issuer-uri OIDC 인데 config 가 mode=none 반환 → **`oidc` 모드 반환**(JwtDecoder 유무).
  (5)[med] Vault 블로킹 호출이 @Transactional 안 → DB 커넥션 점유 → **activeSecrets/listNames 트랜잭션 밖으로**. (6)[med] 프론트 일시 /me 실패에 유효 토큰 폐기 → **401/403 일 때만 폐기**. (7)[med] OIDC 모드 프론트가 dev 로 오인 → **oidc 안내 화면**.
- 검증: 백엔드 test 전종(GithubAuthStartupValidatorTest·AssistantOAuthLinkTest 포함) + fail-closed 라이브(allowed-logins 없이 github 기동 시 IllegalStateException 으로 중단) + tsc/build.

## 최근 변경 (2026-07-28) — 게스트 모드: github 모드에서 로그인 없이 앱 사용, AI만 로그인 게이트

설계: [docs/superpowers/specs/2026-07-28-guest-mode-design.md](docs/superpowers/specs/2026-07-28-guest-mode-design.md).
**github 모드(`FLOWLINK_AUTH_GITHUB_ENABLED=true`)의 의미 변경** — 앱 전체 잠금이 아니라 **"앱은 게스트에게 개방, GitHub 로그인 = AI 사용 + 신원 표시 게이트"**. 별도 플래그 없음(github 모드면 항상 게스트 허용).
- **백엔드**: [SecurityConfig](backend/src/main/kotlin/com/flowlink/security/SecurityConfig.kt) 3분기 — github 게스트 모드는 `/api/v1/assistant/**` 만 `authenticated()`, 나머지 permitAll(Bearer 는 계속 인식 — 로그인 사용자 triggeredBy·Copilot 연결 유지). 레거시 OIDC(issuer-uri) 모드는 기존 엄격 RBAC 그대로, dev 도 무변경. `/auth/me` 비인증은 github 모드에서 `guest`(전권) 반환. jwt-secret fail-closed 기동 가드 유지. `FLOWLINK_AUTH_ALLOWED_LOGINS` 는 "로그인(=AI) 가능 계정" 목록이 됨.
- **presence**: [PresenceHandshakeInterceptor](backend/src/main/kotlin/com/flowlink/presence/PresenceHandshakeInterceptor.kt) — github 모드에서 토큰 없는 WS 접속을 dev 방식(쿼리 name, 게스트 닉네임)으로 허용(무효 토큰은 여전히 401). 게스트도 커서·공동편집 참여.
- **프론트**: [AuthContext](frontend/src/auth/AuthContext.tsx) — github 모드 + 무토큰이면 로그인 화면 대신 **게스트 부트**(`isGuest`), `requestLogin()` 으로 [GitHubLogin](frontend/src/auth/GitHubLogin.tsx) 디바이스 로그인 **모달**. AI 패널 자리엔 [AssistantLoginGate](frontend/src/components/AssistantLoginGate.tsx)(에디터·Mock 편집기), 사이드바 칩은 "게스트 · 로그인". 무토큰 401 은 리로드하지 않음(리로드 루프 방지 — 토큰 있을 때만 폐기·재부트).
- 검증: [GuestModeSecurityTest](backend/src/test/kotlin/com/flowlink/security/GuestModeSecurityTest.kt)(@SpringBootTest — 게스트 CRUD 허용/assistant 401/로그인 200/무효토큰 401/guest me) + presence 인터셉터 단위 3종 + 라이브 curl(게스트 flows 200·POST 201·assistant 401) + tsc/build/oxlint.
- ⚠ **github 모드는 더 이상 앱 잠금이 아니다**(앱 접근 잠금은 레거시 OIDC 뿐). **플러그인 JAR 업로드도 게스트 가능**(dev 모드와 동일 수준 — 사내망 전제, 사용자 승인). 게스트 실행은 triggeredBy 미기록.
  블랭킷 `permitAll` 이라 `/actuator/metrics`·(h2 프로파일의) `/h2-console` 등 나머지 비-assistant 경로도 함께 무인증 개방된다.

## 최근 변경 (2026-08-12) — 스크린샷 사용가이드 세트 (`docs/guide/`)

실사용자용 가이드를 **심플가이드(10분 코스) + 심화 15챕터 + 실제 화면 스크린샷 62장**으로 재구성.
설계: [docs/superpowers/specs/2026-08-12-user-guide-screenshots-design.md](docs/superpowers/specs/2026-08-12-user-guide-screenshots-design.md).
- 구조: [docs/guide/README.md](docs/guide/README.md)(허브) + 심플가이드 + 01~13(시작하기/에디터/노드 레퍼런스 14종/토큰 바인딩/실행·디버깅/환경·시크릿/트리거/이력·스위트/버전·협업/Mock/IO/AI/FAQ) + 14(편의기능 — 프론트 전수 스캔 231건) + 15(폼·콜백 연동 심층 — relay 계약/멱등/재시작 복구). 기존 `docs/사용가이드.md` 는 요약본으로 유지.
- 스크린샷 제작: 격리 H2(`FLOWLINK_H2_FILE`) + 데모 데이터 시딩(Mock pay/corebank·플로우 4종·이력) 후 playwright-core(시스템 Chrome, 1440×900 DSF2, 라이트 테마 고정)로 촬영. 재촬영 시 같은 패턴(시딩→촬영→이미지 검수) 재사용.
- 정확성: 코드 대조 적대 리뷰 2회(확정 19건+6건) 반영 — 단축키·검색 범위·⏹ 중단 시맨틱·통짜형 httpStatus·SET 🔒 값 내보내기 평문 포함 경고·mock 비활성 404·멱등 콜백 평문 OK 등.
- 루트 README 를 가이드 중심으로 갱신(히어로 스크린샷 + 가이드 표). ⚠ 문서가 기능 라벨을 인용하므로 **UI 라벨 변경 시 해당 챕터 갱신 필요**.

## 최근 변경 (2026-08-20) — Vault Transit(KEK) 봉투 암호화 (`feat/transit-kek` 브랜치)

앱 저장 암호화(DB 시크릿·재개 스냅샷·Copilot 토큰)를 **Vault Transit 엔진으로 전면 위임**하는 옵션 —
켜면 암호화 키가 서버 env 에 평문으로 존재하지 않는다(사용자 결정: 부팅 시 DEK 언랩안이 아닌 "전부 Transit"안).
- **[CryptoProvider](backend/src/main/kotlin/com/flowlink/common/crypto/CryptoProvider.kt)** 인터페이스로 암호화 계약 추출 — 구현:
  기존 [StateCrypto](backend/src/main/kotlin/com/flowlink/execution/engine/StateCrypto.kt)(로컬 AES-GCM) ·
  [TransitCrypto](backend/src/main/kotlin/com/flowlink/common/crypto/TransitCrypto.kt)(`POST /v1/{mount}/encrypt|decrypt/{key}`, batch_input 지원) ·
  [RoutingCrypto](backend/src/main/kotlin/com/flowlink/common/crypto/RoutingCrypto.kt)(쓰기=Transit, 읽기=`vault:` 접두사 라우팅+레거시 폴백).
  [CryptoConfig](backend/src/main/kotlin/com/flowlink/common/crypto/CryptoConfig.kt) 가 단일 빈 선택(3곳 자가 생성 제거) + 기동 헬스체크(encrypt→decrypt 왕복, **fail-closed**) + dev 키 WARN 이관.
- 설정: `flowlink.vault.transit.{enabled,mount,key}`(env `FLOWLINK_VAULT_TRANSIT_*`, 기본 transit/flowlink) — address/token 은 기존 vault 설정 재사용. 토큰 없이 켜면 기동 실패.
- **자동 이관**: 기동 시 `secret` 테이블 레거시 행 일괄 재암호화([SecretService.reencryptLegacyOnStartup](backend/src/main/kotlin/com/flowlink/secret/SecretService.kt)) → 이후 `FLOWLINK_EXECUTION_STATE_SECRET` 제거 가능. suspension 은 단명이라 읽기 폴백으로 충분, Copilot 토큰은 재저장 시 이관.
- **성능**: `activeSecrets` 복호화를 `decryptAll`(Transit batch 1회)로 묶음. KEK 로테이션은 `transit/keys/{key}/rotate` — 데이터 재암호화 불필요.
- 검증: 단위 15종(Transit 프로토콜/배치/오류 전파·Routing 접두사/순서 보존·Config 빈 선택/fail-closed·@DataJpaTest 재암호화 이관) + 전체 스위트 그린 + **라이브**(도커 Vault transit 실키): 기동 3로그(Transit 활성·헬스체크 OK·시크릿 2건 재암호화) → `{{ payApiKey@secret }}` 실행 SUCCEEDED + `Bearer ••••••` 마스킹 → Vault 다운 상태 기동 = Connection refused 로 부팅 실패(fail-closed) 확인.
- ⚠ Transit 모드는 Vault **상시 의존**(다운 시 시크릿 실행·재개·재시작 불가 — HA 권장). 상세: [docs/운영가이드.md](docs/운영가이드.md) §6.

### AppRole 인증 (후속 — `feat/vault-approle` 브랜치)
static 토큰 대신 **AppRole 로그인 + 자동 갱신**(정석). [VaultTokenSource](backend/src/main/kotlin/com/flowlink/secret/VaultTokenSource.kt) —
선택 규칙: `approle.role-id`+`secret-id` 설정 시 [AppRoleTokenSource](backend/src/main/kotlin/com/flowlink/secret/VaultTokenSource.kt)(`auth/{mount}/login` → 수명 절반에 `renew-self` → 실패/만료 시 재로그인, 게으른 갱신·synchronized), 아니면 StaticTokenSource(기존 env 토큰, 무회귀).
KV([VaultSecretSource](backend/src/main/kotlin/com/flowlink/secret/VaultSecretSource.kt))와 Transit([TransitCrypto](backend/src/main/kotlin/com/flowlink/common/crypto/TransitCrypto.kt))이 **단일 빈을 공유**(이중 로그인 방지, CryptoConfig 등록). env: `FLOWLINK_VAULT_APPROLE_ROLE_ID`/`SECRET_ID`/`MOUNT`(기본 approle).
fail-closed 메시지가 "토큰 또는 AppRole" 로 확장. 검증: 단위 10종(로그인/캐시/절반 갱신/실패 재로그인/만료 직행 재로그인/전파·선택 규칙 4종) + 라이브(도커 Vault: approle 활성 + **스코프 정책 flowlink-app**(4경로) + token_period=180 role) — 토큰 env 없이 기동(AppRole 로그인 → Transit 헬스체크 OK) → 시크릿 플로우 SUCCEEDED+마스킹 → **만료 후 접근에서 자동 재로그인** 로그 실측. 운영가이드 §6 AppRole 준비 절차 추가.

### 단일 노드 실행 시크릿 평문 유출 수정 (2026-08-28, `fix/single-run-secret-mask`)
`▶ 이 노드만 실행` 응답(SingleNodeRunResult)이 실행 이력 마스킹을 안 거쳐 **requestText 에 시크릿 평문**(`Bearer demo-...`)이 그대로 실리던 유출 —
마스킹 로직을 [SecretMasker](backend/src/main/kotlin/com/flowlink/execution/engine/SecretMasker.kt)(원문+URL 인코딩·JSON 이스케이프 변형, 긴 값 우선)로 추출해
recorder(전체 실행 저장)와 [runSingleNode](backend/src/main/kotlin/com/flowlink/execution/ExecutionService.kt) 응답(requestText/responseText/output JSON 라운드트립)이 공유.
tcp-preview 는 시크릿 미시드라 무관. 단위 5종 + 라이브(단일 실행 LEAK false·`Bearer ••••••`, 전체 실행 무회귀) 확인.

## 최근 변경 (2026-08-28) — 긴 목록 UX 패치: 피커 최근 사용·접기, .env/JSON 일괄 입력, 중복 경고 (`feat/ux-list-polish`)
"리스트가 많아지면 선택이 어렵다(환경변수·응답항목 등) + 입력 디테일" 요청. **전부 프론트 레이어**(백엔드에 필요한 데이터가 이미 있어 무변경). 새 순수 lib 2개 + 기존 컴포넌트 개선.
- **[bulkPaste.ts](frontend/src/lib/bulkPaste.ts)**(순수): `parseDotEnv`(.env 형식 — 주석/`export`/따옴표/콜론/중복은 마지막 값) · `parseOutputKeys`(JSON 객체면 최상위 키+타입 추론 `inferOutputType`, 아니면 쉼표/공백/줄바꿈 나열) · `duplicateKeys`(중복 경고 집합). 단위 16케이스(Node 타입스트리핑).
- **[BindingPicker](frontend/src/binding/BindingPicker.tsx)**: **🕘 최근 사용** 섹션([recentBindings.ts](frontend/src/binding/recentBindings.ts) — localStorage `fl:bind:recent` 최대 8, 현재 sources 에 없는 항목 자동 탈락, 검색 중 숨김) · 소스별 **접기(▾/▸)+항목 수 배지** · 12개 초과 섹션 **+N개 더** 축약 · 검색 **하이라이트**+노드 이름 매칭 시 전체 항목 표시(기존: 빈 섹션 버그) · ↑↓ 활성 칩 scrollIntoView · 검색어 있을 때 Esc=지움(stopPropagation 으로 모달 유지). 렌더/키보드 순서는 단일 `sections` 구조에서 파생(불일치 원천 차단).
- **[EnvManagerDialog](frontend/src/components/EnvManagerDialog.tsx)**: 변수 8개↑ 검색 필터 · **📋 .env 붙여넣기**(같은 키=값 갱신, 토스트 요약) · 환경 **⧉ 복제** · 중복 키 주황 경고 · Enter=다음 행/새 행+포커스(`data-var` + pendingFocus ref).
- **[PropertyPanel](frontend/src/panels/PropertyPanel.tsx) OutputsEditor**: **📋 여러 키 추가**(나열 또는 샘플 JSON→키+타입, 기존 키 스킵) · 중복 키 경고 · 마지막 행 Enter=행 추가(WaitFields/SET VarsEditor 키 입력도 동일).
- **[KeyValueEditor](frontend/src/panels/KeyValueEditor.tsx)**: 중복 키 경고(`warnDupes` prop — **Params 는 끔**, 쿼리 중복은 유효) · 마지막 행 Enter=행 추가.
- **[SecretsDialog](frontend/src/components/SecretsDialog.tsx)**: 6개↑ 이름 검색 · 활성 환경 기준 **✓ 적용/덮임** 배지 + 타 환경 스코프 흐림(우선순위 활성환경>공통>Vault — `SecretService.activeSecrets` 미러).
- **[MockServerEditor](frontend/src/routes/MockServerEditor.tsx)**: 라우트 5개↑ 메서드/경로 검색(원본 인덱스 유지 — 첫 매칭 의미 불변).
- 검증: bulkPaste 단위 16 PASS + tsc/build/oxlint + 브라우저 실측(피커 배지/접기/하이라이트/최근 사용/+3개 더 · .env 붙여넣기 갱신+추가 · JSON 샘플→email/age/active/tags 타입 추론 · 중복 경고 · 시크릿 ✓ 적용/흐림 · 라우트 필터). 가이드 [14장](docs/guide/14-편의기능.md)에 "긴 목록 다루기" 섹션 추가.
- ⚠ 최근 사용은 브라우저 개인 스코프(localStorage). 스크린샷 재촬영은 안 함(기능 추가 — 기존 라벨/화면 유지).

### 2차 디테일 패치(같은 날, 사용자 후속 피드백 6건)
"입력 대규모 업데이트·환경변수 리스트 나열 어려움·피커 기본 접힘·팔레트 크기 제각각·속성 패널 비좁음·가로 스크롤바 이상" 반영:
- **피커 기본 접힘**: [BindingPicker](frontend/src/binding/BindingPicker.tsx) 섹션이 **접힌 채 열림**(소스 ≤2 면 자동 펼침, `openSecs` Set) — 배지 보고 펼치거나 검색.
- **환경 변수 [폼|텍스트] 토글**: [EnvManagerDialog](frontend/src/components/EnvManagerDialog.tsx) VarEditor 에 텍스트 모드 — `.env` 텍스트 통편집, `onTextChange` 가 타이핑마다 `parseDotEnv`→commit(폼/스토어 실시간 동기화, 모드 안 돌아와도 반영). 직렬화는 `키=값` 줄(따옴표 값은 재파싱 시 벗겨짐 — 수용).
- **전역 입력 컨트롤**([index.css](frontend/src/index.css)): 모든 input/select/textarea 에 **포커스 링(보라 테두리+글로우)·호버 보더·플레이스홀더·disabled** 통일 — 컴포넌트 인라인 border 를 이기려 상태 스타일만 `!important`. TokenInput(contentEditable)도 같은 어휘.
- **팔레트 균일 타일**([Palette](frontend/src/canvas/Palette.tsx) `paletteBtn`): width 100%·minHeight 40 — 라벨 길이에 따라 버튼 폭이 제각각이던 문제 해소.
- **속성 패널 여유**: 기본 폭 330→**380**(max 640, [Editor](frontend/src/routes/Editor.tsx) loadSize)·본문 padding 16→16×18·label 간격 확대·field padding 9×11.
- **가로 스크롤바**: 전역 가로 바 높이 10→**7px**+호버 색, `html,body{overflow-x:clip}`(1~2px 오버플로가 문서 가로 바를 만들지 않게), 대시보드 카드 미니 프리뷰([MiniFlow](frontend/src/components/MiniFlow.tsx))는 `.fl-hidden-scroll` 로 바 숨김(스크롤은 유지).
- 검증: tsc/build/oxlint + 브라우저 실측(피커 3소스 접힘/펼침·텍스트 모드 타이핑 즉시 변수 6개 반영·팔레트 균일 폭·패널 380·대시보드/Mock/실행 1000px 폭 오버플로 스캔 bars 0). ⚠ propertyW 는 localStorage 지속이라 이미 드래그했던 브라우저는 저장값 우선(도구 ⋯ 패널 크기 리셋).

### 4차 — 전체화면 편집(사용자 피드백: "모달 거의 전체화면·시크릿 볼트 UX·HTML 편집 불편")
- **[BigTextEditor](frontend/src/components/BigTextEditor.tsx)**(신규): 거의 전체화면(96vw×92vh) 텍스트 편집 모달 + 작은 textarea 우상단에 붙는 `ExpandCorner`(⤢) 버튼. value/onChange 그대로 물려받아 실시간 동기화(Esc 닫기), 글자 수 표시.
  적용: **Mock 규칙 응답 본문**(결제창 HTML 템플릿)·**Mock 콜백 본문**([MockServerEditor](frontend/src/routes/MockServerEditor.tsx) RuleCard) · **wait 콜백 응답 본문**·**HTTP raw 바디**([PropertyPanel](frontend/src/panels/PropertyPanel.tsx) `bigEdit`).
- **넓은 속성 모달(⤢) 거의 전체화면**: [Editor](frontend/src/routes/Editor.tsx) modalCard 760px → `min(1500px,96vw)`×92vh, 내용은 중앙 940px 칼럼(입력이 늘어지지 않게, PropertyPanel `modal` 분기). JSON 보기 모달도 같은 카드 공유로 확대. PropertyPanel width prop `number|string`.
- **시크릿 볼트 UX**: 560→760px, 목록 스크롤 영역 분리(maxHeight 88vh flex), 헤더 개수 배지, 새 시크릿 값 **👁 저장 전 확인 토글**.
- 라이브 확인 중 이 브라우저의 `fl:editor:propertyW=560`(과대 저장값)이 캔버스를 압박 → 380 으로 리셋(코드 무관, "이상해 보임"의 한 원인).
- 검증: tsc/build/oxlint + 실브라우저(:18080 dark) — 전체화면 속성 모달·Mock 결제창 HTML 1,490자 큰 편집기·시크릿 볼트 새 레이아웃 실측.

### 6차 — 전체화면 모달 2단 레이아웃 (사용자: "전체화면이니까 레이아웃을 완전히 더 사용자 친화적으로")
- 5차의 "1080px 로 조이기"를 대체 — 모달을 다시 **96vw(min 1500px)×92vh** 로 벌리고, [PropertyPanel](frontend/src/panels/PropertyPanel.tsx) 이 모달에서 **2단 그리드**로 폭을 실제로 쓴다:
  **HTTP** = 요청 구성(메서드·URL·cURL·고급·프리셋·쿼리·헤더·본문) | 응답·확인(▶ 단일 실행+결과·응답 섹션·요청 미리보기) · **TCP** = 요청 전문 구성(대상·인코딩·프리픽스·요청 필드) | 응답·확인(단일 실행·응답 필드·전문 미리보기).
- 구현: 노드 블록을 IIFE 로 `reqCol`/`respCol` JSX 변수로 분리해 `twoCol ? grid : 세로 흐름` — **도킹 사이드는 기존 렌더 그대로**(JSX 중복 없음). 단일 실행 블록은 `singleRunBlock` 변수로 추출해 도킹=상단/모달 2단=우측 칼럼. 기타 노드 타입 모달은 중앙 940px 칼럼 유지(`modalColW`). 칼럼 제목 `colHead`(요청 구성/응답·확인).
- 실측: TCP·HTTP 모달 2단 렌더 확인(:18080). ⚠ 스테일 페이지(재기동 전 로드)가 남아 있으면 이전 UI 로 보임 — 새로고침 필요.

### 5차 — 코드 편집기(문법 체크)·트랙 칩 가림·모달 미관 (2026-08-29, 사용자 피드백 3건)
- **[CodeEditor](frontend/src/components/CodeEditor.tsx)**(신규, CodeMirror 6): BigTextEditor 가 HTML/JSON/XML 일 때 textarea 대신 —
  **하이라이트(HTML 안의 JS/CSS 포함) + 문법 체크**(JSON=`jsonParseLinter` 오류, HTML/XML=lezer 파스 트리 오류 노드 경고·50개 캡) + 줄번호·접기·다크(oneDark).
  **lazy import 별도 청크**(gzip 200KB — 편집기 열 때만 로드, 본 번들 무변화). BigTextEditor 헤더에 언어 셀렉트(HTML/JSON/XML/텍스트, 미지정 시 내용으로 자동 추정),
  호출부가 language 전달(Mock rule.contentType·wait callbackRespType·HTTP bodyType). ⚠ `{{템플릿}}` 토큰은 문법 경고로 표시될 수 있음(무해, 힌트로 안내). deps: codemirror + @codemirror/lang-html/json/xml·lint·theme-one-dark.
- **스위치 엣지 포트 칩 가림 수정**([DeletableEdge](frontend/src/canvas/DeletableEdge.tsx)): 칩이 소스 핸들 기준 **중앙정렬**이라 긴 트랙 이름의 앞 글자가 노드 밑에 가려짐("Mock 전문"→"Ock 전문") → 칩 왼쪽 끝을 핸들 오른쪽(+10px)에 고정 + maxWidth 130 말줄임 + title. [SwitchNode](frontend/src/canvas/SwitchNode.tsx) 트랙 라벨도 우측 여유 18px·maxWidth 150·title.
- **최대화 모달 미관**: 96vw 가 좌우 텅 비어 "안 예쁘다" → 속성 모달 카드 `min(1080px,96vw)`(높이 92vh 유지), 헤더도 본문과 같은 중앙 940px 칼럼, 배경 **blur(4px)**(Editor modalBackdrop + 공용 Modal OVERLAY). 본문 전체화면은 BigTextEditor 가 담당(96vw 유지).
- 검증: tsc/build(CodeEditor 청크 분리 확인) + 실브라우저 — 결제창 HTML 하이라이트/접기/줄번호, 깨진 태그 입력 시 거터 ⚠, undo 복원(1,490자), 트랙 칩 "Mock 전문/운영 전문" 온전 표시, 1080px 모달.

### 3차 디테일 패치("10개 이상" 추가 발굴, 15건)
키보드·일관성 마이크로 UX — 전부 프론트: ① 피커 헤더 **모두 펼치기 ⇄ 모두 접기** 토글 버튼(기본 접힘의 짝) ② 피커 섹션 헤더 키보드 접근(tabIndex·Enter/Space·aria-expanded) ③ [NodeAddMenu](frontend/src/canvas/NodeAddMenu.tsx) ↑↓ 활성 이동+하이라이트+Enter 선택·빈 상태 문구 ④ 대시보드 검색 **Esc=지우기 + × 버튼** ⑤ 실행 이력 검색 Esc=지우기 ⑥ 팔레트 검색 Esc=지우기 ⑦ 에디터 워크플로 이름 Enter/Esc=확정(blur) ⑧ Mock 보내보기 경로 Enter=전송 ⑨ 시크릿 이름/값 Enter=저장 ⑩ EnvSwitcher 드롭다운 Esc 닫기 ⑪ 도구(⋯) 메뉴 Esc 닫기 ⑫ 전역 `accent-color`(체크박스/라디오 브랜드 색) ⑬ 전역 `::selection` 브랜드 틴트 ⑭ 전역 버튼 커서(enabled=pointer·disabled=not-allowed+opacity .6) ⑮ 입력 크기 리듬 통일(KeyValueEditor·Env/Secrets 다이얼로그 8×10px·12.5px + KVE 행 버튼 높이 32). 검증: tsc/build/oxlint + 브라우저(펼치기/접기 토글·검색 ×/Esc 클리어·포커스 링).

## 참고 문서
- `backend/README.md` — 백엔드 구조·설정·API 요약 · `frontend/README.md` · `infra/README.md`(배포)
- **`docs/guide/`** — 실사용자 가이드(심플+심화 15챕터, 스크린샷) · `docs/사용가이드.md` — 한 페이지 요약본
- **`docs/운영가이드.md`** — 운영자 가이드(yml/env 전체 설정 레퍼런스·인증 모드·암호화 키·체크리스트)
- `docs/superpowers/` — 구현 계획/설계 스펙
