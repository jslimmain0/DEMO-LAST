# FlowLink — 프로젝트 가이드 (유지보수용)

REST API 워크플로 오케스트레이션 플랫폼. 클라이언트 전용 프로토타입을
엔터프라이즈 플랫폼으로 고도화한 것. 백엔드/프론트 모두 **모듈러 모놀리스**(향후 워커 분리 대비
패키지 경계). UI 텍스트는 전부 한국어.

| | 스택 | 포트 |
|---|---|---|
| **Backend** | Spring Boot 3.3.5 / **Kotlin 1.9**(Java 21 toolchain) / JPA + Flyway / **Oracle**(dev 프로파일) / H2 파일(local 프로파일, 기본) / SpEL | 18080 |
| **Frontend** | React 19 / Vite 8 / @xyflow/react / Zustand / React Query / axios | 5173 |

---

## 실행 방법

### 앱 실행 — 리포 루트 `scripts/` (단일 jar, 화면+API 한 프로세스 :18080)
```bash
# Linux/macOS/Git Bash — 기본 프로파일 local(H2 파일 DB). 없으면 --build 로 빌드 후 실행.
bash scripts/start.sh            # (또는 --build)
bash scripts/status.sh           # PID 생존 + 헬스(GET /api/v1/auth/config — HTTP 응답 확인, DB 상태 미포함)
bash scripts/stop.sh
```
```powershell
# Windows (PowerShell) — 같은 lifecycle
powershell -ExecutionPolicy Bypass -File scripts\start.ps1        # (또는 -Build)
powershell -ExecutionPolicy Bypass -File scripts\status.ps1
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
```
> ⚠️ 스크립트는 세트로 써야 한다(.sh 는 .sh 끼리, .ps1 은 .ps1 끼리) — .sh 는 Git Bash PID 를, .ps1 은 Windows PID 를 PID 파일에 쓰므로 섞으면 stop/status 가 서로의 프로세스를 못 찾는다.
- DB 접속 override: `FLOWLINK_DB_URL`, `FLOWLINK_DB_USER`, `FLOWLINK_DB_PASSWORD` · 포트: `FLOWLINK_PORT` · **경로 접두사(context path)**: `FLOWLINK_CONTEXT_PATH=/flowlink`(앱 전체가 `/flowlink/` 밑에서 — 운영가이드 §3)
- 프로파일/인증/Vault 는 env 로 주입(운영): `SPRING_PROFILES_ACTIVE=dev`(Oracle), `FLOWLINK_AUTH_GITHUB_ENABLED=true`, `FLOWLINK_VAULT_TRANSIT_ENABLED=true` — 하단 "최근 변경 (2026-09-14)" 섹션 참조.
- **TLS 신뢰(사내 프록시)**: `start.ps1` 은 Windows 인증서 저장소를 신뢰(`-Djavax.net.ssl.trustStoreType=WINDOWS-ROOT`)해 사내 TLS 가로채기 프록시 뒤에서도 아웃바운드 TLS(AI/Copilot 등)가 된다(끄기 `FLOWLINK_WINROOT=0`). 추가 JVM 옵션은 `FLOWLINK_JAVA_OPTS`(Linux 는 커스텀 truststore 를 이걸로).
  - **최후수단 `FLOWLINK_TLS_INSECURE=true`**: 아웃바운드 TLS 인증서/호스트명 검증을 **전부 끈다**(모든 인증서 신뢰, [FlowlinkApplication.main](backend/src/main/kotlin/com/flowlink/FlowlinkApplication.kt) 이 빈 생성 전 기본 SSLContext 를 trust-all 로 교체). ⚠ MITM 취약 — 신뢰 가능한 사내망 전용, 기동 시 큰 WARN. 정석(WINDOWS-ROOT/CA 추가)이 안 될 때만.
- **H2 파일 위치**(local 프로파일): 기본 `~/flowlink-h2db/flowlink.mv.db` (사용자 홈). 변경: `FLOWLINK_H2_FILE`. 초기화: 그 `.mv.db` 삭제.
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
./gradlew test   # 백엔드 테스트 전종 (DB 불필요 — 기본 프로파일 local(application-local.yml) 위에 각 테스트의 @TestPropertySource 가 h2:mem URL·ddl-auto·flyway off 를 덮어씀)
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
 │           HttpNodeExecutor·NodeRecorder
 │           RelayController(wait 콜백 수신 → 자동 재개)
 └─ config   ExecutionProperties·HttpClientConfig
folder/      폴더 관리
mock/        Mock 서버 기능 — 워크플로가 호출할 가짜 대상 시스템을 정의·서빙(1급 리소스)
 │           MockServerController(관리 CRUD)·MockGatewayController(/mock/{slug}/** 서빙)
 │           MockRuntime(라우트 매칭·조건·템플릿)·MockCallbackDispatcher(콜백 발사)
security/    GitHub 로그인(자체 JWT 리소스서버) + TenantClaimFilter·TenantContext (멀티테넌시)
transform/   변환 SPI + JAR 플러그인 (TransformRegistry·PluginController)
common/      error·json·tenant
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
  나머지 모듈 경계는 여전히 패키지로 표현.

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
- 인증: `FLOWLINK_AUTH_GITHUB_ENABLED=true` 면 GitHub 게스트 모드(자체 JWT 검증), 미설정 시 dev permitAll
- 멀티테넌시: JWT claim(기본 "tenant") → `TenantContext`(ThreadLocal) → 쿼리 `tenant_id` 필터
- HTTP req/res 본문은 항상 저장하되 시크릿 마스킹(SecretMasker) 적용. 마스킹은 시크릿 볼트 값에 한정(노드에 직접 적은 토큰은 그대로 저장), 시크릿 조회 실패 시 마스킹 없이 저장(WARN).
- IF 표현식: SpEL `SimpleEvaluationContext`(읽기전용) 샌드박스

### 주요 설정 (`application.yml` / `ExecutionProperties`)
`flowlink.execution.*`: http 타임아웃·max-response-bytes(5MB)·max-nodes-per-run(200)
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
- **플러그인 JAR 샌드박스 없음** — 업로드 JAR가 전체 권한으로 실행(업로드 자체는 관리자 게이트 — PluginController)
- **RLS** 미도입 — 멀티테넌시는 `tenant_id` 컬럼 필터링만(시크릿 볼트·전역 ADMIN/워크스페이스 롤은 구현됨)
- **SET 노드 시크릿** UI 마스킹만, 실제 KMS 연동 없음
- **graph_json** text 저장 — Phase 2에 JSONB 마이그레이션 예정

### 리팩토링 후보 (프론트)
- `PropertyPanel.tsx`(404줄) — 노드 타입별 컴포넌트 분리 권장
- 토스트/에러 알림 시스템 없음 (플러그인 업로드 에러 silent catch)
- 노드 검색 없음 (Undo/Redo·서브그래프 복붙은 2026-07-06 구현됨)
- OpenAPI 파서: ref 1단계만, YAML 미지원, `allOf/oneOf/anyOf` 미처리

### 테스트 현황
- 백엔드 단위 테스트: `ExpressionEvaluatorTest`·`TokenResolverTest`·`MockRuntimeTest` 등 (DB 불필요)
- 통합 테스트는 @SpringBootTest + H2 인메모리(GuestModeSecurityTest·WorkspaceRbacTest·MockFleetTest 등). E2E·프론트 테스트 없음

---

## 최근 변경 (2026-09-14) — 설정 트림: 안 쓰는 기능 통째 제거 (`refactor/trim-config`)
브랜치 `refactor/trim-config` 11개 커밋 요약. OIDC·allowed-logins·SSRF·Vault KV·프로파일 정리의 상세(코드 위치·주의사항)는 문서 하단의 같은 날짜 개별 섹션 참조; 나머지(Springdoc·Actuator·CORS·capture·내장 변환)는 이 목록이 전부.
- **제거 목록**: Springdoc/Swagger UI(`/swagger-ui.html`·`/v3/api-docs`, OpenApiConfig) · Actuator/Prometheus(`management.*`, micrometer) · SSRF 가드(`flowlink.execution.ssrf.*`, SsrfGuard·SsrfBlockedException·SsrfGuardTest) · 캡처 옵션(`capture.request-response-bodies` — HTTP 본문은 항상 SecretMasker 마스킹 후 저장) · `flowlink.security.cors-origins`(`/api/**` CORS 전체 오리진 허용) · 레거시 OIDC 모드(issuer-uri/Keycloak — 인증 모드는 dev | GitHub 둘뿐, SecurityConfig 2분기) · `FLOWLINK_AUTH_ALLOWED_LOGINS`/`FLOWLINK_AUTH_ADMIN_LOGINS` · Vault KV 오버레이(`mount/path/config-path/refresh-seconds`, VaultSecretSource, 시크릿 목록 `source=vault` 배지, Vault `flowlink-config/jwt-secret` — jwt-secret 은 env `FLOWLINK_AUTH_JWT_SECRET` 만) · 내장 변환(BuiltinTransforms) · 콜백 base env(`flowlink.execution.relay.base-url`/`FLOWLINK_EXECUTION_RELAY_BASEURL` — RelayBaseResolver 는 화면 설정 → 접속 오리진 → localhost) · `state-secret`(`FLOWLINK_EXECUTION_STATE_SECRET` — StateCrypto 는 고정키, CryptoConfig WARN 한 줄).
- **프로파일 변경**: `application-h2.yml` → `application-local.yml`(**`local` = H2 파일, 기본** — `spring.profiles.default`), Oracle datasource/flyway 는 새 `application-dev.yml`(**`dev` = Oracle**, `SPRING_PROFILES_ACTIVE=dev` + `FLOWLINK_DB_URL`). 구 `=oracle`/`h2` 는 무효.
- **헬스 프로브**: `/actuator/health` → `GET {ctx}/api/v1/auth/config`(scripts start/status.(sh|ps1)·infra/connect-local.ps1). 새 헬스 컨트롤러 없음.
- **관리자 부트스트랩**: env 화이트리스트 대신 **테넌트에 ADMIN 이 없을 때 처음 로그인하는 사용자(기존 DB 의 사용자 포함)가 자동 승인 + 전역 ADMIN**(WorkspaceService.touchUser), 이후 로그인은 PENDING → 관리 콘솔(/admin) 승인. dev 모드의 `dev` 는 항상 관리자.
- **변환은 플러그인 전용**: 새 인스턴스는 JAR 업로드 전까지 변환 목록이 비어 있음(`backend/plugin-sample` 참고). 같은 id 는 나중에 로드된 JAR 가 덮어씀.
- **어시스턴트 Anthropic 직접(api-key) 경로 제거**: `flowlink.assistant.api-key/model/base-url`(`FLOWLINK_ASSISTANT_API_KEY/MODEL/BASE_URL`)·시크릿 볼트 `anthropic-api-key` 조회·Anthropic Messages 포맷(anthropicBody/extractAnthropicText, x-api-key)·authMode "key" 삭제. 자격은 사용자별 GitHub 로그인(Copilot, OpenAI 호환) → 없으면 stub 뿐. AssistantService 의 SecretService 주입 제거. 기존에 Anthropic 키로 쓰던 인스턴스는 무경고로 stub 이 된다.
- Vault 는 Transit(KEK) 봉투 암호화 + 정적 토큰/AppRole 만 남음(스위치 `FLOWLINK_VAULT_TRANSIT_ENABLED`). 이력 본문의 옛 서술에는 "(2026-09-14 제거됨)" 표기만 덧붙였고 문장은 고치지 않았다.

## 최근 변경 (2026-06-29)

### HTTP 노드 요청 방식: 서버→서버 / 클라이언트→서버 (`reqMode`)
- HTTP 노드에 `reqMode: 'server' | 'client'` 선택. PropertyPanel `ReqModeToggle`, NodeCard 배지(S→S/C→S)
- **server**(기본): 백엔드 실행 엔진이 호출(SSRF 가드 적용(2026-09-14 제거됨), 동기) — 기존 동작
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
  - `MockCallbackDispatcher`: 지연 발사 + "OK" 미수신 시 2초 간격 3회 재발송(노티 규약), SsrfGuard 적용(2026-09-14 제거됨).
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
- ⚠️ mock 서빙 무인증(테스트 도구 전제, slug 는 비밀값 아님)·상태 없음(범용 목)·콜백 SsrfGuard 적용(운영 프로파일은 사설망 발사 차단)(2026-09-14 제거됨).

### mock 대상 시스템(mock-server.js) + 데모 워크플로 스위트(demos/)
설계: [docs/superpowers/specs/2026-07-04-mock-demo-suite-design.md](docs/superpowers/specs/2026-07-04-mock-demo-suite-design.md).
"모든 기능을 실제로 테스트"하기 위한 가짜 대상 시스템 + 완성 데모 6종. **백엔드/프론트 코드 무변경**(기존 기능만 사용).
- **mock-server.js**(리포 루트, node:http+node:net, 의존성 0, HTTP :9090 · TCP :9091): 위 실행 방법 섹션 참조.
  결제 게이트웨이는 결제창(승인/거절 버튼)→`/pay/approve`→returnUrl 자동 POST 브리지(실 PG merchant-return 패턴),
  notiUrl 서버 노티(파이어&포겟)도 지원. EUC-KR 응답은 Node 가 인코딩 불가(TextEncoder=UTF-8 전용)라
  고정 문자열("홍길동")의 EUC-KR 바이트를 하드코딩, 요청 디코딩은 `TextDecoder('euc-kr')`.
  TCP 는 TcpNodeExecutor 규약(4자리 ASCII 길이 프리픽스·자기 미포함) 그대로 구현.
- **demos/*.json 6종**: 01 결제(SET·FORM·WAIT·IF·HTTP — 타임아웃/거절 분기 포함), 02 OTP(INPUT, waitMsg 에
  `{{ hint@… }}` 토큰), 03 주문 API(Bearer 헤더 바인딩·qty number 타입·경로 바인딩·concat TRANSFORM(내장 변환은 2026-09-14 제거됨)),
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
- **(2026-07-06 TCP 부활로 대체)** ~~TCP 노드 완전 제거~~: `TcpNodeExecutor`·`TcpField`/`TcpRespField`·고정길이 금융 전문(BAL1) 삭제. 노드 타입 = start/end/set/if/assert/http/form/wait/input/transform (TCP 없음). SSRF 가드도 HTTP 전용(2026-09-14 제거됨).
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
  + 바이트 고정길이 필드 조립/슬라이싱, 인코딩 노드/필드별, `SsrfGuard.checkHostPort`(2026-09-14 제거됨)), `NodeType.TCP`,
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
  ②를 "명시했을 때만"으로 만듦(`ExecutionProperties.Relay.configured`). (② env 단계·`Relay.configured` 는 2026-09-14 제거됨)
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
  키는 SHA-256(`flowlink.execution.state-secret`), **미설정 시 dev 폴백 키 + 기동 WARN**(운영에선 반드시 설정)) (state-secret 은 2026-09-14 제거됨 — 고정키) — ctx 에 시크릿/응답 본문이 실리므로.
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

> (이 섹션의 OIDC 모드·SecurityConfig `PUBLIC_PATHS` 는 2026-09-14 제거됨 — `?token=` JWT 검증은 github 모드에서 동일하게 동작, 무토큰은 게스트.)

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
  `spring.flyway.locations: classpath:db/migration/{vendor}`. h2 프로파일(2026-09-14 `local` 로 개명)은 flyway off 그대로(무영향).
- **oracle 프로파일**(`application-oracle.yml` — 파일은 제거됨, 2026-09-14 `dev`(application-dev.yml) 로 정리): ojdbc11(runtime)+
  flyway-database-oracle, `hibernate.type.preferred_uuid_jdbc_type: CHAR`, **`ddl-auto: none`**(엔티티
  `columnDefinition="text"` 12곳이 Oracle validate 와 충돌 — Flyway 가 스키마 소유), ssrf allow-loopback(내장 mock 호출, 2026-09-14 제거됨).
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
- **실행 실패 알림**: [NotificationService](backend/src/main/kotlin/com/flowlink/notify/NotificationService.kt)(FAILED settle 시 비동기 파이어&포겟) → 테넌트 설정 웹훅(Slack/Teams `{text}`). `GET/PUT /api/v1/settings/notify`(admin), SettingsDialog 알림 필드. ⚠ admin 설정 URL 이라 스킴만 검증(전체 SsrfGuard 미적용 — SsrfGuard 는 2026-09-14 제거됨).
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
  - **키 해석**: env `FLOWLINK_ASSISTANT_API_KEY`/yml → 시크릿 볼트 `anthropic-api-key`. 둘 다 없으면 **stub 모드**(키워드 기반 결정적 샘플: http/otp/결제/tcp) — 키 없이도 기능 완결. [AssistantProperties](backend/src/main/kotlin/com/flowlink/assistant/AssistantProperties.kt)(`flowlink.assistant.*`). (2026-09-14 제거됨 — Copilot|stub 만)
  - **하드닝**(적대적 리뷰 7건): LLM 컨텍스트로 보내기 전 **SET secret=true 변수 값 마스킹**(하드코딩 토큰은 감지 불가 → 시크릿 볼트 권장) · 동시 호출 **벌크헤드**(Semaphore, `max-concurrent`=4, 초과 429) · 적용 전 크래시 안전 검증([graphValidate](frontend/src/lib/graphValidate.ts), 수동 가져오기와 공용) · Enter 전송 **IME 가드**(한글 조합 중 오전송 방지) · 좁은 화면 자동 속성패널 접기 · 깨진 JSON 본문 400([GlobalExceptionHandler](backend/src/main/kotlin/com/flowlink/common/error/GlobalExceptionHandler.kt), 앱 전역). SsrfGuard 는 api.anthropic.com 통과(2026-09-14 제거됨). RBAC=editor 이상.
- 검증: 단위(AssistantJsonTest 6·백엔드 무회귀) + assistant e2e 21/21(config·인텐트별 그래프 유효성(START·엣지 포맷·IF포트)·제안 그래프 저장/실행 터미널 도달·멀티턴·깨진본문 400) + 브라우저 실측(✨열기→제안→적용 3→8노드 교체·노드 접기 85→39px·폭 230 고정) + tsc/build/oxlint.
- ⚠ 어시스턴트는 사용자 그래프를 외부 LLM(Anthropic)에 보냄(키 설정 시)(2026-09-14 Anthropic 키 경로 제거됨) — 시크릿 볼트 토큰은 이름만, SET 시크릿 값은 마스킹, 그 외 하드코딩 값은 그대로 전송(옵트인 전제). LLM 호출은 요청 스레드 동기(벌크헤드로 상한). 키 없으면 외부 호출 없음(stub 로컬).

## 최근 변경 (2026-07-18) — 어시스턴트: 프롬프트 라이브러리(awesome-copilot 식) + GitHub OAuth 팝업 로그인
> ⚠ 이 영역은 여러 번 재정의됐다(히스토리): HTTP 노드 OAuth2(폐기 e21c265) → 어시스턴트 OAuth(범용 provider) → **현재: GitHub 전용 팝업**. 스킬도 플로우 조각(폐기) → **현재: 프롬프트**. 아래가 최종.
- **스킬 = 재사용 프롬프트(awesome-copilot 스타일)**: 스킬은 **{name, description, prompt}**([Skill](backend/src/main/kotlin/com/flowlink/assistant/SkillDtos.kt)) — awesome-copilot.github.com 처럼 자주 쓰는 프롬프트를 저장. [SkillsDialog](frontend/src/components/SkillsDialog.tsx)(어시스턴트 💬) 라이브러리에서 **▶ 적용** 하면 그 프롬프트를 어시스턴트에 전송. **내장 스킬 없음**(사용자 정의). 프롬프트는 자동 주입 안 함(불러 씀) — **팀 지침(instructions)** 만 시스템 프롬프트에 자동 주입([SkillService.promptBlock](backend/src/main/kotlin/com/flowlink/assistant/SkillService.kt), admin). 저장은 설정 JSON(마이그레이션 없음 — AppSetting.value=text, H2 dev 는 [AppSettingSchemaFix](backend/src/main/kotlin/com/flowlink/settings/AppSettingSchemaFix.kt)로 CLOB 확장).
- **실제 GitHub Copilot 연결(디바이스 플로우 — VS Code Copilot 확장과 동일)**: 관리자 설정 없이(client_id 는 Copilot 공개값 고정) 사용자가 **Copilot 연결** 버튼 → [AssistantOAuthService](backend/src/main/kotlin/com/flowlink/assistant/AssistantOAuthService.kt) 가 `github.com/login/device/code` 로 디바이스 코드 발급 → 프론트가 코드 표시 + `github.com/login/device` 를 열어 사용자가 입력 → 백엔드 백그라운드 폴러가 토큰 취득·저장(AES-GCM). 채팅 시 GitHub 토큰 → **Copilot 토큰**(`api.github.com/copilot_internal/v2/token`, 캐시) → **Copilot API**(`api.githubcopilot.com/chat/completions`, `Editor-Version`/`Copilot-Integration-Id` 등 확장 헤더) 호출. [AssistantService](backend/src/main/kotlin/com/flowlink/assistant/AssistantService.kt) 포맷 분기: **Copilot→OpenAI 호환(Bearer)** / **api-key→Anthropic(x-api-key)**. 자격 우선순위 Copilot→key→stub. (2026-09-14 key 경로 제거됨)
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
  TenantClaimFilter·[SecurityConfig](backend/src/main/kotlin/com/flowlink/security/SecurityConfig.kt) OIDC 브랜치를 **무변경 재사용** (OIDC 브랜치는 2026-09-14 제거됨 — 지금은 GitHub 모드 분기 하나가 같은 필터를 쓴다).
- **코드**: [AuthProperties](backend/src/main/kotlin/com/flowlink/security/AuthProperties.kt)(`flowlink.auth.*`) ·
  [AppJwt](backend/src/main/kotlin/com/flowlink/security/AppJwt.kt)(Nimbus HS256 발급 `issue()` + 검증 `decoder()`, 키=SHA-256(secret) 32B) ·
  [GithubAuthService](backend/src/main/kotlin/com/flowlink/security/GithubAuthService.kt)(device/code → 백그라운드 폴 → `api.github.com/user` → 가입 등록(WorkspaceService.touchUser) → appJwt) ·
  [AuthConfig](backend/src/main/kotlin/com/flowlink/security/AuthConfig.kt)(`github-enabled=true` 일 때만 `JwtDecoder` 빈 등록 → 인증 브랜치 활성) ·
  [AuthController](backend/src/main/kotlin/com/flowlink/security/AuthController.kt)(`/auth/config` mode=github|none · `/me` · `/github/device/start` · `/github/device/poll`, 전자 3개 permitAll).
- **프론트**([auth/](frontend/src/auth/)): oidc-client-ts 제거 → localStorage 토큰([auth.ts](frontend/src/auth/auth.ts)) + [GitHubLogin](frontend/src/auth/GitHubLogin.tsx)(디바이스 코드 카드·폴링) +
  [AuthContext](frontend/src/auth/AuthContext.tsx) github 모드. axios Bearer + 401 시 토큰 폐기·재로그인. `usePermissions()` 게이팅 불변.
- **env**: `FLOWLINK_AUTH_GITHUB_ENABLED`(기본 false=dev permitAll). github-enabled=true 면 **서명 시크릿 필수**(없으면 공개 dev 키로 토큰 위조 → [GithubAuthStartupValidator](backend/src/main/kotlin/com/flowlink/security/AuthConfig.kt) 가 기동 실패). 서명 시크릿은 env `FLOWLINK_AUTH_JWT_SECRET`([AppJwt](backend/src/main/kotlin/com/flowlink/security/AppJwt.kt)).
  client_id 는 Copilot 공개 client 기본(`AuthProperties.clientId`).
- 검증: 자체서명 HS256 토큰으로 `/me`·`/flows` 인증 통과·역할 매핑·위조서명 401·무토큰 401·실제 GitHub device 코드 발급·브라우저 로그인 화면 렌더.

### 배포 재편: `deploy/` → `infra/`, 앱은 도커 밖, Vault 인프라
- **메인 앱은 도커에 안 올린다** — 서버(EC2)에서 `scripts/start.sh`(위 실행 방법)로 단일 jar 실행. [infra/Dockerfile](infra/) 제거.
- **[infra/docker-compose.yml](infra/docker-compose.yml)** = 지원 인프라만: **Vault**(dev, Transit, :8200) + **Oracle**(`--profile oracle`, 로컬 테스트용).
  Keycloak 서비스·realm·`keycloak-dev.compose.yml` 전부 제거. 앱 서비스도 제거. `docker compose -f infra/docker-compose.yml up -d`.
- **기본 DB = Oracle**(Postgres 지원 제거) — base `application.yml` 이 Oracle(ddl-auto none·uuid CHAR·flyway {vendor}=oracle·ssrf allow-loopback(SSRF 가드 2026-09-14 제거됨)).
  구 `application-oracle.yml`·`db/migration/postgresql/`·PG 드라이버/flyway-pg/testcontainers-pg 제거. **로컬 dev 는 h2 프로파일**(scripts 기본).
  Oracle 로 기동: `SPRING_PROFILES_ACTIVE=oracle`(scripts h2 기본을 벗어나는 스위치 — 설정은 base) + `FLOWLINK_DB_URL`. 사내/별도 Oracle 로는 URL 만 교체(스키마는 Flyway `db/migration/oracle` 통합 V1+V9~V12 가 생성). (2026-09-14 프로파일 정리로 대체 — `local`(H2, 기본)/`dev`(Oracle), `=oracle` 무효)
- [infra/README.md](infra/README.md)·`.env.example`·SERVER-DEVELOPMENT.md 를 새 구조로 재작성. 구 lifecycle(flowlink-start/stop·server-rebuild)은 `scripts/` 로 통합.

### HashiCorp Vault 시크릿 연동 (시크릿 볼트에 오버레이)
> **2026-09-14 제거됨** — KV 오버레이·config-path jwt-secret 은 삭제, Transit/AppRole 만 유지(하단 최근 변경 참조).
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
  (1)[high] github-enabled + jwt-secret 미설정 → 공개 dev 키로 토큰 위조 → **fail-closed 기동 실패**(GithubAuthStartupValidator). (2)[high] 빈 allowed-logins → 누구나 admin: 초기엔 필수화했으나 **사용자 결정으로 선택 유지**(비면 전체 허용 + 기동 WARN)(2026-09-14 제거됨) — jwt-secret 강제는 유지.
  (3)[med] 무인증 device/start 남용 → 폴러 스레드 폭주 → **동시 세션 상한(MAX_SESSIONS=20)**. (4)[med] issuer-uri OIDC 인데 config 가 mode=none 반환 → **`oidc` 모드 반환**(JwtDecoder 유무).
  (5)[med] Vault 블로킹 호출이 @Transactional 안 → DB 커넥션 점유 → **activeSecrets/listNames 트랜잭션 밖으로**. (6)[med] 프론트 일시 /me 실패에 유효 토큰 폐기 → **401/403 일 때만 폐기**. (7)[med] OIDC 모드 프론트가 dev 로 오인 → **oidc 안내 화면**. ((2) allowed-logins·(4)(7) oidc 모드·(5) Vault KV 호출은 2026-09-14 제거됨)
- 검증: 백엔드 test 전종(GithubAuthStartupValidatorTest·AssistantOAuthLinkTest 포함) + fail-closed 라이브(allowed-logins 없이 github 기동 시 IllegalStateException 으로 중단 — allowed-logins 는 2026-09-14 제거됨, 현재 기동 가드는 jwt-secret 만) + tsc/build.

## 최근 변경 (2026-07-28) — 게스트 모드: github 모드에서 로그인 없이 앱 사용, AI만 로그인 게이트

설계: [docs/superpowers/specs/2026-07-28-guest-mode-design.md](docs/superpowers/specs/2026-07-28-guest-mode-design.md).
**github 모드(`FLOWLINK_AUTH_GITHUB_ENABLED=true`)의 의미 변경** — 앱 전체 잠금이 아니라 **"앱은 게스트에게 개방, GitHub 로그인 = AI 사용 + 신원 표시 게이트"**. 별도 플래그 없음(github 모드면 항상 게스트 허용).
- **백엔드**: [SecurityConfig](backend/src/main/kotlin/com/flowlink/security/SecurityConfig.kt) 3분기(OIDC 분기는 2026-09-14 제거 → 현 2분기) — github 게스트 모드는 `/api/v1/assistant/**` 만 `authenticated()`, 나머지 permitAll(Bearer 는 계속 인식 — 로그인 사용자 triggeredBy·Copilot 연결 유지). 레거시 OIDC(issuer-uri) 모드는 기존 엄격 RBAC 그대로, dev 도 무변경. `/auth/me` 비인증은 github 모드에서 `guest`(전권) 반환. jwt-secret fail-closed 기동 가드 유지. `FLOWLINK_AUTH_ALLOWED_LOGINS` 는 "로그인(=AI) 가능 계정" 목록이 됨. (레거시 OIDC 모드·ALLOWED_LOGINS 는 2026-09-14 제거됨)
- **presence**: [PresenceHandshakeInterceptor](backend/src/main/kotlin/com/flowlink/presence/PresenceHandshakeInterceptor.kt) — github 모드에서 토큰 없는 WS 접속을 dev 방식(쿼리 name, 게스트 닉네임)으로 허용(무효 토큰은 여전히 401). 게스트도 커서·공동편집 참여.
- **프론트**: [AuthContext](frontend/src/auth/AuthContext.tsx) — github 모드 + 무토큰이면 로그인 화면 대신 **게스트 부트**(`isGuest`), `requestLogin()` 으로 [GitHubLogin](frontend/src/auth/GitHubLogin.tsx) 디바이스 로그인 **모달**. AI 패널 자리엔 [AssistantLoginGate](frontend/src/components/AssistantLoginGate.tsx)(에디터·Mock 편집기), 사이드바 칩은 "게스트 · 로그인". 무토큰 401 은 리로드하지 않음(리로드 루프 방지 — 토큰 있을 때만 폐기·재부트).
- 검증: [GuestModeSecurityTest](backend/src/test/kotlin/com/flowlink/security/GuestModeSecurityTest.kt)(@SpringBootTest — 게스트 CRUD 허용/assistant 401/로그인 200/무효토큰 401/guest me) + presence 인터셉터 단위 3종 + 라이브 curl(게스트 flows 200·POST 201·assistant 401) + tsc/build/oxlint.
- ⚠ **github 모드는 더 이상 앱 잠금이 아니다**(앱 접근 잠금은 레거시 OIDC 뿐 — 2026-09-14 제거됨). **플러그인 JAR 업로드도 게스트 가능**(dev 모드와 동일 수준 — 사내망 전제, 사용자 승인). 게스트 실행은 triggeredBy 미기록.
  블랭킷 `permitAll` 이라 (h2 프로파일(2026-09-14 `local` 로 개명)의) `/h2-console` 등 나머지 비-assistant 경로도 함께 무인증 개방된다.

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
- **자동 이관**: 기동 시 `secret` 테이블 레거시 행 일괄 재암호화([SecretService.reencryptLegacyOnStartup](backend/src/main/kotlin/com/flowlink/secret/SecretService.kt)) → 이후 `FLOWLINK_EXECUTION_STATE_SECRET` 제거 가능(2026-09-14 env 자체 제거됨). suspension 은 단명이라 읽기 폴백으로 충분, Copilot 토큰은 재저장 시 이관.
- **성능**: `activeSecrets` 복호화를 `decryptAll`(Transit batch 1회)로 묶음. KEK 로테이션은 `transit/keys/{key}/rotate` — 데이터 재암호화 불필요.
- 검증: 단위 15종(Transit 프로토콜/배치/오류 전파·Routing 접두사/순서 보존·Config 빈 선택/fail-closed·@DataJpaTest 재암호화 이관) + 전체 스위트 그린 + **라이브**(도커 Vault transit 실키): 기동 3로그(Transit 활성·헬스체크 OK·시크릿 2건 재암호화) → `{{ payApiKey@secret }}` 실행 SUCCEEDED + `Bearer ••••••` 마스킹 → Vault 다운 상태 기동 = Connection refused 로 부팅 실패(fail-closed) 확인.
- ⚠ Transit 모드는 Vault **상시 의존**(다운 시 시크릿 실행·재개·재시작 불가 — HA 권장). 상세: [docs/운영가이드.md](docs/운영가이드.md) §6.

### AppRole 인증 (후속 — `feat/vault-approle` 브랜치)
static 토큰 대신 **AppRole 로그인 + 자동 갱신**(정석). [VaultTokenSource](backend/src/main/kotlin/com/flowlink/secret/VaultTokenSource.kt) —
선택 규칙: `approle.role-id`+`secret-id` 설정 시 [AppRoleTokenSource](backend/src/main/kotlin/com/flowlink/secret/VaultTokenSource.kt)(`auth/{mount}/login` → 수명 절반에 `renew-self` → 실패/만료 시 재로그인, 게으른 갱신·synchronized), 아니면 StaticTokenSource(기존 env 토큰, 무회귀).
Transit([TransitCrypto](backend/src/main/kotlin/com/flowlink/common/crypto/TransitCrypto.kt))이 CryptoConfig 의 단일 빈을 사용. env: `FLOWLINK_VAULT_APPROLE_ROLE_ID`/`SECRET_ID`/`MOUNT`(기본 approle).
fail-closed 메시지가 "토큰 또는 AppRole" 로 확장. 검증: 단위 10종(로그인/캐시/절반 갱신/실패 재로그인/만료 직행 재로그인/전파·선택 규칙 4종) + 라이브(도커 Vault: approle 활성 + **스코프 정책 flowlink-app**(4경로 — KV read 2경로는 2026-09-14 제거, 현재 transit 2경로) + token_period=180 role) — 토큰 env 없이 기동(AppRole 로그인 → Transit 헬스체크 OK) → 시크릿 플로우 SUCCEEDED+마스킹 → **만료 후 접근에서 자동 재로그인** 로그 실측. 운영가이드 §6 AppRole 준비 절차 추가.

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

### 10차 — 접힘 기본값 정리 + 시크릿/환경 그룹핑 (사용자 피드백 4건)
- **'JSON 붙여넣기→필드 채우기' 버튼 제거** — Raw 에 붙여넣고 [필드] 전환과 동일(왕복이 안정된 뒤 중복). Body 힌트가 그 흐름을 안내.
- **이전 노드 값 입력 기본 접힘**([PropertyPanel](frontend/src/panels/PropertyPanel.tsx) `upOpen`) — 헤더에 (N개 · M개 입력됨) 표시, **접혀 있어도 값은 단일 실행에 적용**. 노드 전환 시 접힘 초기화.
- **응답(파싱 설정) 섹션 기본 펼침**(`secDefault('resp')` false→true) — 실행 결과를 보는 흐름과 붙어 있어야 해서.
- **시크릿 볼트 스코프 그룹핑**([SecretsDialog](frontend/src/components/SecretsDialog.tsx)): 실행 우선순위 순서로 섹션 — **활성 환경 → 공통 → Vault → 기타 환경(미적용, 기본 접힘)**, 헤더에 개수·접기, 검색 중엔 전부 펼침. (사용자가 시크릿 16개를 만들어 둔 상태에서 실측 — 공통 15 펼침/prod 1 접힘 확인)
- **환경 변수 누락 감지**([EnvManagerDialog](frontend/src/components/EnvManagerDialog.tsx)): "다른 환경에는 있는데 여기 없는 키 N개: …" 안내 + **[+ 빈 값으로 추가]**(VarEditor `missingKeys` prop — 환경 전환 시 값 누락 예방).

### 9차 — 요청 json-in-json + 배지 일관성 (사용자: "사용처 배지 일관성·요청 쪽도 중첩·입력 편하게")
- **요청 JSON 경로 조립**: [JsonPathBuilder](backend/src/main/kotlin/com/flowlink/execution/engine/JsonPathBuilder.kt)(신규, 응답 dig 의 대칭) — JSON 본문 필드 키에 `customer.name`·`items[0].sku` 를 쓰면 **중첩 JSON 으로 전송**([HttpNodeExecutor](backend/src/main/kotlin/com/flowlink/execution/engine/HttpNodeExecutor.kt) json 필드 분기, 평평한 키 무회귀·인덱스 갭 null·타입 충돌 시 마지막 쓰기 승). 단위 5종.
  ⚠ 점(.) 포함 키를 평평하게 보내야 하는 API 는 Raw 모드 사용(필드 모드는 경로로 해석).
- **필드↔Raw 중첩 왕복**([bodyConvert](frontend/src/lib/bodyConvert.ts)): `fieldsToRaw`(json) 가 리터럴 트리로 중첩 조립(값은 타입별 리터럴·토큰은 따옴표 유지), `rawToFields`(json) 가 중첩 객체를 점 경로 행으로 평탄화(깊이 4·배열은 한 행(array)·점 든 실키는 평탄화 안 함). 라운드트립 단위 7케이스. Body 섹션에 점 경로 힌트 문구.
- **사용처 배지 일관성**: OutputsEditor 배지를 **모든 행에 고정 폭(44px)으로 항상 표시** — 0곳=흐림·비클릭(툴팁 안내), N곳=초록 클릭. 행마다 레이아웃이 널뛰던 문제 해소.
- 데모 플로우 v3: 승인 통보 본문을 점 경로 필드로, mock /notify 는 `{{body}}` echo → 통보 확인이 `{{ echo.customer.grade@notify }}` 중첩 검증. 실행 SUCCEEDED + 전송 본문 `{"customer":{"name":"김철수",...},"approval":{"code":"0000"},"items":[{"sku":"A-100"}]}` 실측.

### 8차 — 워크벤치 적대적 토론(에이전트 3렌즈) 확정안 반영 (사용자: "확대했을 때 저게 최선이냐 토론시켜 봐")
API 도구 UX·비주얼/IA·플로우 통합 3관점 병렬 비평 → 확정 반영:
- **[중요 버그] Esc 중첩 닫힘 수정**: [useEscapeClose](frontend/src/components/useEscapeClose.ts) 를 **모듈 전역 Esc 스택**으로 — 가장 위에 뜬 모달만 반응(마운트 순서=스택). 워크벤치 안에서 피커/큰 편집기 열고 Esc 시 워크벤치까지 닫히며 편집 유실되던 문제. Editor 의 propModal raw 리스너도 `registerEscapeClose` 로 통합.
- **워크벤치**: ⑴ 지난 전체 실행의 이 노드 결과 **자동 로드**(`lastRunQ` — runs limit1→detail→NodeExecution, 🕘 배지+트리, ▶ 실행 시 대체) ⑵ **실제 전송 요청** 접기(single.requestText — 토큰 치환·마스킹된 전송값, "요청 미리보기(토큰 미해석)"와 구분) ⑶ 미리보기를 **좌측 요청 칼럼**으로 이동 ⑷ **Ctrl/Cmd+Enter=실행** ⑸ 응답 배지에 **durationMs**(백엔드 SingleNodeRunResult 필드 추가, 벽시계).
- **플로우 통합**: 이웃 칩에 **분기 갈래 태그**(IF T/F·스위치 트랙명, `portLabelOf`) · 출력 키에 **"N곳" 사용처 배지**(`outputUsage` — 하류 노드 토큰 스캔, 키/하위 경로 참조, 클릭=첫 사용처로 이동+모달 닫힘) · 모달 헤더에 **활성 환경**(🌐) 표시.
- **비주얼/IA**: 모달 헤더 재설계(이름=제목 스타일+타입·#id 메타 통합, 풀폭 입력 제거) · 하단 복제/삭제 **컴팩트 우측 정렬+구분선**(`compactAction`) · colHead 위계 강화(13px/800) · 우측 칼럼 섹션 제목 "응답 (Response)"→**"파싱 설정 · 출력 키"**(중복 라벨 해소, 도킹은 기존) · **비워크벤치 타입 모달 축소**(Editor — http/tcp 외엔 `min(820px,94vw)`·height auto).
- 기각(에이전트 합의): Authorization 탭(과거 폐기 방향), 응답 헤더 전면 캡처(백엔드 다층 변경), 쿠키 잭(무상태 철학 충돌), 미니 캔버스, 그래프 자동 재실행(부수효과 위험). 유보: 단일 실행 미니 히스토리·응답 트리 검색.
- 실측: 워크벤치(지난 실행 ✓HTTP 200·16ms 트리·grade "1곳" 배지·헤더 메타) + assert 모달(820px·`grade@사용자 조회`=VIP 입력→▶ 실행 ✓ 성공·1ms·result true·실제 전송 요청 접기).

### 7차 — 중첩 JSON 경로 바인딩 + 단일 실행 상류 값 입력 (사용자: "json 안에 json 어떻게 표현? 대충 만든 거 아니냐")
- **중첩 경로 바인딩**: [TokenResolver](backend/src/main/kotlin/com/flowlink/execution/engine/TokenResolver.kt) `dig()` — `{{ user.name@노드 }}`·`{{ user.addr.city@노드 }}`·`{{ items[0].id@노드 }}`(=`items.0.id`).
  규칙: **평평한 실키 우선**(응답에 `"a.b"` 키가 문자 그대로 있으면 그것), 부재는 `Missing` 센티널로 값-null 과 구분(**bare 토큰의 상위 노드 폴스루 유지**), 전체-토큰 리터럴 원형 보존(조건식 숫자 비교 동작). 토큰 문법 key 클래스에 `[ ]` 추가(백엔드 TOKEN·[tokenGrammar.ts](frontend/src/lib/tokenGrammar.ts) 미러). 단위 3케이스+라이브 E2E(중첩 assert SUCCEEDED·오경로 FAILED·flat-key 우선) ALL PASS. ⚠ 단일 실행 E2E 시 확인: **플로우 생성은 `POST /flows`(graph 무시) 후 `POST /flows/{id}/versions`** — graph 를 create 에 실어도 조용히 무시됨.
- **[JsonTree](frontend/src/components/JsonTree.tsx)**(신규): 워크벤치 응답 패널의 클릭 가능한 JSON 트리 — **키 클릭 = `{{ 경로@노드 }}` 토큰 복사**, [트리|Raw] 토글, 타입별 색·접기. '이 응답에서 키 채우기'는 중첩 경로까지 펼쳐 채움(깊이 3·40개 캡).
- **단일 실행 상류 값 입력**(사용자: "바인딩 있으면 단일 실행 안 되잖아 — 입력받게 해"): [PropertyPanel](frontend/src/panels/PropertyPanel.tsx) `detectUpstreamTokens`(노드 JSON 스캔, env/input/secret/req:/자기자신 제외) → **'이전 노드 값 입력' 폼**(도킹·워크벤치, 노드별 localStorage `fl:uprun:*` 기억, 숫자/불리언/JSON 코어션) → `RunRequest.upstream`({소스노드:{키:값}}, bare 는 `__prev`) → [ExecutionService.runSingleNode](backend/src/main/kotlin/com/flowlink/execution/ExecutionService.kt) 가 `ctx.putOutput` 시드. E2E: 값 없이 FAILED → 주입 시 OK(중첩 경로 포함).

### 6차 — 전체화면 모달 = API 워크벤치 (사용자: "좌우만 바꾼다고 편해지냐, 넓어진 걸 잘 써라" 재설계)
- 단순 2단 재배치(1차안)를 버리고 **포스트맨 어휘의 워크벤치**로 재설계([PropertyPanel](frontend/src/panels/PropertyPanel.tsx), 모달 96vw×92vh):
  - **HTTP**: 상단 **URL 바 [메서드|Base URL|Path|▶ 실행]** 한 줄 → 좌 "요청"(cURL·프리셋·고급·쿼리/헤더/본문 — **모달에선 섹션 기본 펼침**, json/xml raw 본문은 **인라인 CodeMirror**(260px, `CodeEditorLazy` 재사용)) | 우 "응답"(**실행 응답이 크게** — 상태칩+본문 38vh, 실행 전엔 점선 빈 상태 안내 → 아래에 출력 키 매핑·'이 응답에서 키 채우기'·요청 미리보기). **작성→실행→응답→키 매핑이 한 화면에서 좌→우로 흐른다.**
  - **TCP**: 좌 "요청 전문 구성" | 우 단일 실행+응답(빈 상태 안내 포함)+응답 필드+전문 미리보기.
- 구현: http 블록을 IIFE 안에서 `methodEl/baseUrlEl/pathEl/urlExtras/reqRest/respCfg` JSX 조각으로 분해 — **도킹은 기존 세로 흐름을 같은 조각으로 조립**(JSX 중복 없음). `runResultBox`(결과)와 `singleRunBlock`(버튼+결과, 도킹용) 분리. `secIsOpen` 이 모달에선 기본 true. 스타일 `wbBar/wbRunBtn/respEmpty/twoColGrid/colHead`.
- 실측(:18080): URL 바 ▶ 실행 → 우측 응답 패널 ✓ 성공·HTTP 200 + JSON(김철수/VIP/52000) 크게 표시 → 바로 아래 키 채우기. ⚠ 스테일 페이지(재기동 전 로드)는 새로고침 필요.

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

## 최근 변경 (2026-08-29) — 워크스페이스(폴더 상위 뎁스) + 롤 기반 접근 제어 + admin 계정 관리 (`feat/workspaces-rbac`)
"admin 계정 관리(팀/롤 베이스) + 롤 기반 워크플로 접근 + 폴더 위 상위 뎁스(워크스페이스, 개인 기본 제공)" 요청.
- **모델**: `workspace/` 모듈 — [Workspace](backend/src/main/kotlin/com/flowlink/core/domain/Workspace.kt)(PERSONAL|TEAM) ·
  [WorkspaceMember](backend/src/main/kotlin/com/flowlink/core/domain/WorkspaceMember.kt)(OWNER/EDITOR/VIEWER, (ws,username) 유니크) ·
  [AppUser](backend/src/main/kotlin/com/flowlink/core/domain/AppUser.kt)(전역 롤 ADMIN|MEMBER, 사용자 레지스트리). `flow`/`folder` 에 `workspace_id`(V13 oracle, h2 는 ddl-auto).
  **공용 = DB 행 없는 가상 워크스페이스**(workspace_id NULL, API 표현 `'public'`) — 모두(게스트 포함) EDITOR 라 기존 데이터/동작 100% 호환.
- **롤 판정**([WorkspaceService](backend/src/main/kotlin/com/flowlink/workspace/WorkspaceService.kt)): 공용=모두 EDITOR ·
  개인=소유자 OWNER(로그인 사용자마다 `listMine` 시 자동 생성 "개인 — {user}") · 팀=멤버십 · **전역 ADMIN=모든 워크스페이스 OWNER 격**.
  ADMIN 판정 = dev 모드 'dev'(항상) OR AppUser.globalRole(최초 관리자는 touchUser 부트스트랩). 사용자명=JWT `preferred_username`(github 게스트=guest).
  403 은 신규 [ForbiddenException](backend/src/main/kotlin/com/flowlink/common/error/ForbiddenException.kt)+핸들러.
- **강제 지점 = definition 레이어**: [FlowService](backend/src/main/kotlin/com/flowlink/definition/FlowService.kt) `readable()/writable()`(loadFlow 가 requireRead, 쓰기 경로 전부 requireWrite — VIEWER 조회만) + `list(workspaceId)` 스코프 목록(레포 파생 쿼리 2종) + create/import 가 workspaceId 배정. [FolderService](backend/src/main/kotlin/com/flowlink/folder/FolderService.kt) 동일(하위 폴더는 상위 워크스페이스 승계, 교차 워크스페이스 이동 400). ~~워크스페이스 삭제 = 공용 승격~~(당시 기록 — 적대 리뷰에서 비공개 데이터 공개 [H] 판정, **삭제 실행자의 개인 ws 이관**으로 변경, 아래 리뷰 항목), 개인은 삭제 불가(관리자 정리는 허용), 마지막 OWNER 내보내기 400.
- **API**: `GET/POST/DELETE /api/v1/workspaces` + `/{id}/members`(GET/PUT/DELETE) · `GET /api/v1/admin/me`(admin 여부 — 프론트 관리 메뉴 게이트) · `/admin/users`(GET/PUT/DELETE, ADMIN 전용). flows/folders 의 GET `?workspaceId=`, 생성 body `workspaceId`('public'/null=공용).
- **프론트**: [Dashboard](frontend/src/routes/Dashboard.tsx) 사이드바 **워크스페이스 스위처**(select 🌐공용/🔒개인/👥팀 + "＋ 새 팀…" + ⚙관리, localStorage `fl:workspace`, 전환 시 위치/검색/선택 초기화, 사라진 ws 는 공용 복귀) — flows/folders 쿼리·생성·복제가 현재 ws 스코프. **VIEWER 면 편집 UI 전체 숨김**(기존 canEdit 합성). [WorkspaceDialog](frontend/src/components/WorkspaceDialog.tsx) — [멤버] 탭(롤 select·내보내기·워크스페이스 삭제 2단계 확인) + [사용자(admin)] 탭(전역 롤 토글). AppShell 네비 라벨 "워크스페이스"→"메뉴"(신규 스위처와 용어 충돌 해소).
- **노드 복사 시간 경과 후 죽는 버그 수정**(b97cb2d, 선행 커밋): RF 의 preventDefault 로 낡은 텍스트 선택/포커스가 남아 Ctrl+C/V 가드에 걸리던 것 — [FlowCanvas](frontend/src/canvas/FlowCanvas.tsx) `reclaimCanvasFocus()`(노드/캔버스 클릭·드래그 시 입력 blur+선택 해제).
- 검증: [WorkspaceRbacTest](backend/src/test/kotlin/com/flowlink/workspace/WorkspaceRbacTest.kt) 6종(@SpringBootTest — JWT 심어 non-admin 경로: 개인 타인 403·VIEWER 쓰기 403·비멤버 조회 403·마지막 OWNER 보호·삭제 시 공용 승격·resolveId) + 전체 스위트 그린 + 라이브 API e2e(공용+개인 자동생성·팀 생성/멤버·플로우/폴더 워크스페이스 격리·admin users) + 브라우저 실측. 프론트 tsc/build/oxlint.
- **실행 레이어 워크스페이스 게이트(후속 확장, 같은 날)**: `GET /executions` 에 `?workspaceId=` — [ExecutionRepository.findFiltered](backend/src/main/kotlin/com/flowlink/core/repository/ExecutionRepository.kt) 가 `EXISTS(flow.workspaceId)` 로 스코프(무필터 `listRecent` 는 내 실행 한정이라 미스코프). **flowId 직접 필터면 그 flow 의 워크스페이스가 스코프**(파라미터 불일치로 빈 결과 방지 — 실행 상세 모달의 flow 이력). [ExecutionService](backend/src/main/kotlin/com/flowlink/execution/ExecutionService.kt): `get`/`listForFlow`/`previewTcp`=requireRead · `run(MANUAL)`/`runSingleNode`=requireWrite(**VIEWER 는 실행 불가**) — 트리거 발화(SCHEDULE/WEBHOOK)는 등록 시 승인이라 스케줄러 스레드(guest/dev) 신원으로 재판정 않음. [Executions](frontend/src/routes/Executions.tsx) 페이지에 워크스페이스 셀렉트(`fl:workspace` 대시보드와 동기화). WorkspaceRbacTest 7종으로 확장.
- **관리 콘솔 페이지(같은 날 후속)**: `/admin` 라우트([Admin.tsx](frontend/src/routes/Admin.tsx)) — **관리자 전용** 회원·팀·권한 관리.
  [사용자] 탭: 전역 롤(ADMIN/MEMBER) 변경(자기 자신은 불가)·소속 팀 칩(역인덱스)·사용자 사전 등록(로그인 전 팀 배정용)·삭제(**팀 멤버십도 정리**).
  [팀·권한] 탭: 팀 생성/삭제(2단계 확인)·팀별 멤버 카드(롤 select·내보내기·추가)·개인 워크스페이스 접힌 목록+**관리자 정리 허용**([WorkspaceService.delete](backend/src/main/kotlin/com/flowlink/workspace/WorkspaceService.kt) — PERSONAL 삭제는 admin 만, 내용물 공용 승격).
  백엔드 `GET /admin/workspaces`(전체 ws+멤버+flowCount 1왕복, [AdminController](backend/src/main/kotlin/com/flowlink/workspace/WorkspaceController.kt)). 네비 "🛡 관리"는 [AppShell](frontend/src/app/AppShell.tsx) 이 `/admin/me` 로 관리자에게만 노출(+백엔드 403 이중 방어). 대시보드 ⚙ 다이얼로그에 "관리 콘솔 →" 링크.
- **가입 신청/승인 모델(사용자 피드백 — "계정 타이핑이 이상하다, 로그인 이력=신청으로")**: 수동 사용자 등록 제거 →
  **GitHub 로그인 = 가입 신청**. [AppUser.status](backend/src/main/kotlin/com/flowlink/core/domain/AppUser.kt)(PENDING|APPROVED|BLOCKED, null=레거시 승인 간주, V14 oracle) —
  [GithubAuthService](backend/src/main/kotlin/com/flowlink/security/GithubAuthService.kt) 가 로그인 성공 시 WorkspaceService.touchUser 로 등록(PENDING)·**BLOCKED 는 토큰 발급 거부**.
  [WorkspaceService.isApproved](backend/src/main/kotlin/com/flowlink/workspace/WorkspaceService.kt) 게이트:
  **승인 전엔 공용만**(개인 ws 미생성·팀 생성 403·assistant chat/mock 403 — [AssistantController.requireApproved](backend/src/main/kotlin/com/flowlink/assistant/AssistantController.kt)). 팀 접근은 멤버십으로 별도(OWNER 초대≠전역 승인).
  관리 콘솔: **🔔 가입 신청 섹션**(승인/차단 버튼)+네비 "관리" 대기 수 배지(`/admin/me`.pendingCount)+상태 필(승인/대기/차단됨)+차단↔해제,
  팀 멤버 추가는 타이핑 대신 **등록 사용자 select**. `PUT /admin/users/{u}` 는 {globalRole?, status?}(자기 차단/강등 400). WorkspaceRbacTest 8종.
- **유령 트리거 버그 수정(같은 날, 이력 확인 중 발견)**: flow 를 삭제(archive)해도 그 flow 의 SCHEDULE 트리거가 20초마다 영원히 발화해 실행 이력을 무한 오염(실측: 최근 200건 중 199건이 삭제된 flow "g" 의 예약 실행). [TriggerService](backend/src/main/kotlin/com/flowlink/trigger/TriggerService.kt) `claimScheduleFire`/`claimWebhookFire` 에 `flowGone`(부재/archive) 가드 — 발화 대신 **트리거 자동 비활성**(WARN 로그).
- **적대적 멀티에이전트 리뷰(10 렌즈 병렬 → 확정 반영, 같은 날)** — "Mock 권한 + 어설픈 관리자 처리" 후속. 주요 반영:
  - **Mock 서버 워크스페이스 스코프(V15)**: [MockServer.workspaceId](backend/src/main/kotlin/com/flowlink/core/domain/MockServer.kt) + [MockServerService](backend/src/main/kotlin/com/flowlink/mock/MockServerService.kt) 읽기(get/requests/state)=requireRead·쓰기(create/meta/spec/delete/reset/clear)=requireWrite, 목록 `?workspaceId=`. **서빙(/mock/{slug})은 무인증 그대로**(외부 시스템 호출 대상 — UI 문구로 명시). slug 유니크는 테넌트 스코프 유지. [MockServers](frontend/src/routes/MockServers.tsx) 페이지 ws 셀렉트+롤 합성, MockServerEditor 도 Detail.workspaceId 로 VIEWER 읽기전용.
  - **[H] 트리거 = 실행 게이트 우회 봉인**: [TriggerService.requireFlow(write)](backend/src/main/kotlin/com/flowlink/trigger/TriggerService.kt) — 등록/수정/삭제=requireWrite(VIEWER·비멤버가 웹훅 만들어 run 의 MANUAL 게이트를 우회하던 권한 상승), 조회=requireRead(웹훅 토큰 노출 방지).
  - **[H] resume 게이트**: [ExecutionService.resume](backend/src/main/kotlin/com/flowlink/execution/ExecutionService.kt) 에 requireWrite — 비멤버가 팀 실행에 임의 노드 출력 주입 불가(외부 콜백은 recordWaitCallback 별도 경로라 무영향). **listRecent 폐기** — `GET /executions` 는 항상 워크스페이스 스코프(무필터 경로가 게스트에게 전 워크스페이스 이력을 유출).
  - **[H] 팀/개인 ws 삭제 = 공용 공개 버그** → 내용물(flow/folder/**mock**)을 **삭제 실행자의 개인 워크스페이스로 이관**([reassignWorkspace](backend/src/main/kotlin/com/flowlink/core/repository/FlowRepository.kt) 3종). deleteUser 는 [purgeUser](backend/src/main/kotlin/com/flowlink/workspace/WorkspaceService.kt) — 멤버십 정리 + 개인 ws 흡수(GitHub 핸들 재사용자가 전임자 데이터를 물려받던 [H] 봉인).
  - **[H] github 모드 서비스 레벨 게이트**(URL RBAC 는 OIDC 전용이었음): 플러그인 JAR 업로드=관리자(게스트 RCE 봉인) · 시크릿 쓰기=승인 사용자 · 설정 쓰기=관리자(+notify GET 은 비관리자 마스킹) · assistant 지침=관리자(스토어드 프롬프트 인젝션)·skills=승인·oauth device/모델=승인+모델 화이트리스트.
  - **RBAC 로직**: roleFor 존재확인을 admin 단축보다 먼저(없는 ws 에 flow 배정 고아 방지) · isApproved 는 BLOCKED 가 DB-ADMIN 보다 우선(dev 만 예외) · putMember 가드(개인 ws 400·예약계정 guest/dev 400·마지막 OWNER 강등 400) · listMine 중복/개인 멤버십 행 제외 · createTeam 이름 길이/중복 400 · 개인 ws 유니크 인덱스(V16).
  - **폴더/flow 교차 배치 봉인**: create/moveToFolder 가 폴더-워크스페이스 일치 검증([FlowService.requireFolderInWorkspace](backend/src/main/kotlin/com/flowlink/definition/FlowService.kt)), FolderService.create 는 상위 폴더 ws 불일치 400(승계 아님). SuiteController 는 읽기 권한 없는 flow 를 응답 전에 제외(이름 열거 유출).
  - **에디터 VIEWER 읽기전용**: [FlowDetail](backend/src/main/kotlin/com/flowlink/definition/dto/FlowDetail.kt) 에 workspaceId+myRole → [Editor](frontend/src/routes/Editor.tsx) 합성 canEdit + editorStore.readOnly 로 PropertyPanel/AssistantPanel/캔버스 우클릭 전파. 저장 403 은 서버 메시지 표시.
  - **presence 게이트**: 핸드셰이크 접근 판정을 flow 존재 → **워크스페이스 롤(username)** 로 교체(게스트/비멤버의 팀 방 입장·편집 현황 노출 차단).
  - **가입 신청 UX**: `/admin/me`.myStatus(GUEST/PENDING/APPROVED/BLOCKED) — AppShell 칩 "⏳ 승인 대기 중"·대시보드 안내·[AssistantLoginGate](frontend/src/components/AssistantLoginGate.tsx) reason=pending(Copilot 연결 헛수고 방지, oauth device/start 도 서버 403). 네비 배지 60초 폴링. 디바이스 로그인 poll 은 **1회성 소비**(쿼리스트링 sessionId 로 JWT 반복 회수 봉인+세션 슬롯 즉시 반환), 프론트 폴 연속 실패 3회 시 안내 종료.
  - **관리 콘솔 다듬기**: 승인/차단 토스트+행 단위 처리중, 검색 대소문자 버그, me 로딩 스켈레톤(비관리자 깜빡임 방지), 파괴 버튼 중복 클릭 가드, 테이블 가로 스크롤, 팀 멤버 행 상태 필, WorkspaceDialog 의 중복 [사용자] 탭 제거(콘솔 단일 진입점, SPA Link).
  - **대시보드 잔결함**: 죽은 ws localStorage 정리(가짜 "백엔드 연결 실패" 방지) · 게스트/PENDING 에 "＋ 새 팀" 숨김 · 최근 실행 ws 스코프 · 폴더 컨텍스트 액션 scopeReady 가드 · 즐겨찾기 ws 별 분리.
  - 검증: WorkspaceRbacTest **12종**(트리거/Mock 게이트·putMember 가드·purgeUser·개인 ws 이관) + 전체 스위트 그린 + 라이브 e2e/브라우저.
- **관리 콘솔 전면 리빌딩(사용자 피드백 "UX/UI 안 좋다 — 리빌딩해", 같은 날)**: [Admin.tsx](frontend/src/routes/Admin.tsx) 재작성 —
  상단 **현황 스트립 4카드**(멤버/가입 신청(대기 시 강조)/팀+개인/워크플로+Mock, 클릭=탭 이동) · 세그먼트 탭(카운트 배지) · ↻ 새로고침(스피너).
  [사용자] 신청 큐(아바타·신청 시각·**모두 승인 N**)+멤버 테이블(아바타·상태 필터 칩(전체/승인/차단)·정렬(최근 접속/이름)·**전역 롤 세그먼트**(ADMIN/MEMBER, 본인 잠금)·승인 직후 행 초록 하이라이트 4초).
  [팀] 공용 요약 카드+팀 카드(**멤버 아바타 스택**·워크플로/Mock/멤버/생성 메타·롤 select·내보내기)+개인 워크스페이스 행(소유자 상태·최근 접속).
  파괴적 동작은 공용 [ConfirmChip](frontend/src/routes/Admin.tsx)(클릭→[취소|확정] 인라인, 4초 자동 해제)으로 전부 통일. Avatar 는 username 해시 색(콘솔 전역 동일).
  백엔드: AdminWorkspaceView.mockCount + publicMockCount([MockServerRepository](backend/src/main/kotlin/com/flowlink/core/repository/MockServerRepository.kt) count 2종).
- **워크스페이스 export/import + Mock 충돌 방지(같은 날 후속)**: [WorkspaceTransferService](backend/src/main/kotlin/com/flowlink/workspace/WorkspaceTransferService.kt) —
  `GET/POST /workspaces/{id}/export|import`('public' 허용) — **폴더 트리(ref 재매핑)+워크플로(현재 그래프, GraphValidator 검증)+Mock(spec)** 을 한 JSON 텍스트로.
  import 는 전부 새 id·원본 불변, **mock slug 충돌은 `-2` 자동 개명**(서빙 주소 전역 유일), **TCP mock 은 꺼서 가져옴**(포트 전역 자원 — 경고로 보고).
  UI 는 [WorkspaceDialog](frontend/src/components/WorkspaceDialog.tsx) "워크스페이스 이동" 섹션 — 내보내기(전체 복사)/가져오기(붙여넣기) **텍스트 복붙**, 결과 요약+경고 목록.
  Mock slug 는 `GET /mock-servers/slug-check` + 생성 폼 **실시간 ✓사용 가능/✕사용 중**(350ms 디바운스, 400 에러 메시지도 전역 유일 이유 명시). RBAC 테스트 13종(라운드트립·VIEWER 가져오기 403).
- ⚠ **잔여 경계(의식적 수용)**: BLOCKED 는 신규 로그인+승인 게이트만 즉시 — 이미 발급된 JWT(12h)의 공용 접근은 만료까지 유지(매 요청 status 검사 필터는 후속). Mock 서빙·TCP 포트는 전역(무인증 테스트 도구 전제). 시크릿/환경/설정은 테넌트 스코프(워크스페이스 무관). removeMember 의 OWNER 카운트는 비관적 락 없음(동시 상호 내보내기 이론상 레이스 — 관리자 복구 가능).

## 최근 변경 (2026-08-29) — 성능 분석·개선 배치 (실측 → 핫스팟 → 수정 → 재실측)
로컬 H2(:18080) 실측 기반. 대부분 엔드포인트 4~8ms 로 양호했고, 두 개의 실제 핫스팟을 수정.
- **[대형] 실행 이력 유령 오염 257,000행**: 과거 유령 스케줄 트리거(수정 전 버그)가 남긴 실행이 실제로는 **25만+ 행**
  (이전 6,200 집계는 페이징 상한 오류). `/executions` 가 p50 7ms / **p95 568ms** 바이모달이던 원인.
  → **관리자 purge API**(`POST /api/v1/admin/executions/purge` {flowId|olderThanDays}, RUNNING/WAITING 보호,
  조건 없는 전체 삭제 400 — [ExecutionService.purgeExecutions](backend/src/main/kotlin/com/flowlink/execution/ExecutionService.kt)) 신설 + 전량 정리 → **3~5ms 균일**(스파이크 소멸). 운영가이드 §12 에 보존 정책 예시.
  42일 묵은 좀비 WAITING 1건은 resume(aborted)로 종결 후 정리.
- **[중형] flows 목록 = N+1 + 반복 파싱**: flow 당 현재 버전 재조회(N 쿼리) + 요청마다 그래프 JSON 파싱.
  → [findCurrentByFlowIds](backend/src/main/kotlin/com/flowlink/core/repository/FlowVersionRepository.kt) 일괄 조회(원격 Oracle 왕복 제거)
  + **(flowId, versionNo) 키 요약 캐시**(그래프는 버전별 불변 — 자연 무효화, [FlowService.GraphDigest](backend/src/main/kotlin/com/flowlink/definition/FlowService.kt)). 100개 목록 19.4ms → **11.7ms**(잔여는 68KB 응답 직렬화).
- **N+1 일괄 제거**: 폴더별 count([countGroupByFolder](backend/src/main/kotlin/com/flowlink/core/repository/FlowRepository.kt)) · 관리 콘솔 ws 별 flow/mock count+멤버(3N+1 → 고정 5쿼리, countGroupByWorkspace/findByWorkspaceIdIn).
- **인덱스**: `execution(tenant_id, started_at)`(V17 + @Table 인덱스 — H2 dev 는 ddl-auto 로 자동), flow/folder workspace_id @Table 인덱스(H2 파리티 — Oracle 은 V13/V15).
- **isAdmin 5초 캐시**: 실행 폴링(0.4초 tick)의 워크스페이스 게이트가 매번 사용자 행을 조회하던 것 — putUser/deleteUser 에서 즉시 무효화([invalidateRoleCache](backend/src/main/kotlin/com/flowlink/workspace/WorkspaceService.kt)).
- 관찰(수정 안 함): 프론트 본 번들 gzip 275KB(CodeEditor 200KB 는 lazy 분리됨) · listFiltered 의 offset 은 off+limit 페치(대형 offset 비효율 — 실사용 200 상한이라 무해) · mock 서빙 ~5ms.
- ⚠ purge 는 UI 없음(API 전용) — 관리 콘솔 버튼은 후속 후보. 요약 캐시·isAdmin 캐시는 단일 인스턴스 스코프.
- **자동 보존 정책(후속 — 사용자 요청 "1·2 해결")**: [maintenance/RetentionService](backend/src/main/kotlin/com/flowlink/maintenance/RetentionService.kt) —
  6시간 주기 스윕(기동 90초 후 1회): ① 실행 이력 `retention.execution-days`(기본 90일, RUNNING/WAITING 보호) ② 버전 스냅샷
  `retention.flow-versions-keep`(기본 flow 당 100개 — **실행 이력·트리거 참조 버전은 보호**, [pruneOldVersions](backend/src/main/kotlin/com/flowlink/core/repository/FlowVersionRepository.kt)).
  0=끄기. 전용 데몬 스레드(TriggerScheduler 관례), 단일 인스턴스 스코프. RetentionServiceTest 2종(백데이트는 JdbcTemplate).

### 📌 보존 버전(커밋) — 자동 정리에서 영구 제외되는 버전 (2026-08-30)
"커밋같이 보존하는 버전" 요청 — git 커밋처럼 메시지를 달아 남기는 스냅샷. 위 보존 정책의 짝(정리에서 빼는 수단).
- **모델**: [FlowVersion.pinned](backend/src/main/kotlin/com/flowlink/core/domain/FlowVersion.kt)(`Boolean?`, null=false — 레거시/H2 ddl-auto 호환 관례, V18 oracle) —
  [pruneOldVersions](backend/src/main/kotlin/com/flowlink/core/repository/FlowVersionRepository.kt) JPQL 에 `pinned IS NULL OR pinned = false` 제외 조건.
- **API**: `SaveVersionRequest.pinned`(저장과 동시에 보존 — 커밋) + `PUT /flows/{id}/versions/{no}/pin` `{pinned}`(기존 버전 토글,
  [FlowService.setVersionPinned](backend/src/main/kotlin/com/flowlink/definition/FlowService.kt) — writable 게이트). `FlowVersionSummary.pinned` 노출.
- **UI**([VersionHistoryDialog](frontend/src/components/VersionHistoryDialog.tsx)): 헤더 아래 **커밋 바**(메시지 입력 + 📌 보존 버전으로 저장 —
  현재 캔버스(미저장 편집 포함)를 pinned 새 버전으로, Enter 지원) · 목록 행 `📌 보존` 배지 · 상세 pane **📌 이 버전 보존/보존 해제** 토글 ·
  워크스페이스 VIEWER(editorStore.readOnly)는 커밋 바/토글/복원 숨김.
- 검증: RetentionServiceTest(📌 v2 가 keep=2 스윕에서 생존) + `:test` 전종 그린 + API 왕복(pinned 저장→토글→목록) + 브라우저 실측(커밋 바 저장 → v8 📌 배지·해제/재보존 토글). 가이드 [09장](docs/guide/09-버전-협업.md)·운영가이드 §12 갱신.

## 최근 변경 (2026-09-08) — Mock 전문 코덱(요청 전/응답 후 플러그인) + Mock 단건 export/import (`feat/mock-codec-transfer`)
"Mock 도 export/import 복붙 + Mock 응답에 플러그인" 요청. 플러그인은 값 하나 변환이 아니라 **전문 전체 코덱**(전문을 다 만든 뒤 나가기 전 / 들어온 전문이 매칭에 들어가기 전)으로 — 기존 FlowTransform 플러그인(내장+JAR — 내장 변환은 2026-09-14 제거됨)을 그대로 쓴다.
- **모델**: [MockSpec.codec](backend/src/main/kotlin/com/flowlink/mock/MockSpec.kt) `{request:[step], response:[step]}` + `MockRoute.codec`(있으면 **통째로** 서버 codec 대체 — 필드 병합 아님, `{}` 면 그 라우트는 코덱 없음). step=`{id, config:[KV], inputKey?, outputKey?}`(기본 첫 입력→첫 출력, 다중 포트만 지정). 스키마 변경 없음(spec_json).
- **[MockCodec](backend/src/main/kotlin/com/flowlink/mock/MockCodec.kt)**(순수, 플러그인 조회 람다 주입): 단계 순서대로 체인. 실패는 `CodecException`(플러그인 없음/예외/출력 없음) — HTTP 500 JSON(게이트웨이 catch-all)·TCP 연결 종료+WARN. 빈 id 단계는 건너뜀(편집 중).
- **HTTP**: [MockRuntime.match](backend/src/main/kotlin/com/flowlink/mock/MockRuntime.kt) 에 `prepare` 훅(경로/메서드 매칭된 라우트에 대해 **조건 평가 전** 요청 교체) + `Match.req`(코덱 적용 요청) · `render(…, responseCodec)`(템플릿 렌더 후·문자셋 인코딩 전, 헤더/콜백 미적용). [MockGatewayController](backend/src/main/kotlin/com/flowlink/mock/MockGatewayController.kt) 가 TransformRegistry 연결, 디코딩 후 `parseBodyFields` 재파싱, journal 에 `decodedBody`(원문과 나란히 — UI "코덱 적용 후:").
- **TCP**: [TcpMockRegistry](backend/src/main/kotlin/com/flowlink/mock/TcpMockRegistry.kt) Listener 가 spec.codec 보유(핫스왑) — 디코딩 전문으로 contains 매칭·`{{req}}` 에코, 렌더 후 response 코덱 → 인코딩·프리픽스.
- **프론트**: [MockCodecEditor](frontend/src/components/MockCodecEditor.tsx)(서버 섹션 "전문 코덱" + 라우트 카드 "이 라우트만 코덱" 공용 — `GET /transforms` 목록·파라미터 폼·다중 포트 셀렉트·순서 이동). [MockTransferDialog](frontend/src/components/MockTransferDialog.tsx)(내보내기 복사/다운로드 · 목록 가져오기=새 Mock(slug 실시간 검사, 충돌 시 `-N` 자동 제안, create+updateSpec 실패 시 빈 mock 정리) · 편집기 가져오기=현재 spec 덮어쓰기(미저장 편집)). 순수 [lib/mockTransfer.ts](frontend/src/lib/mockTransfer.ts)(포맷 `{kind:"flowlink-mock",version:1,name,slug,type,spec}`, 워크스페이스 번들 오붙여넣기 안내, TCP 는 꺼서 가져옴). 백엔드 신규 API 없음.
- 검증: 단위(MockCodecTest 8·MockRuntime 코덱 훅 2·mockTransfer 8) + 전체 스위트 그린 + **라이브 e2e 17**(서버 코덱 base64 디코딩→조건 매칭→인코딩·journal decodedBody·라우트 `{}` 무효화·응답만 코덱·알 수 없는 플러그인 500·config 전달·TCP 코덱·export/import 라운드트립+코덱 보존+서빙) + **브라우저 17**(가져오기/내보내기 다이얼로그·slug 자동 제안·코덱 섹션/파라미터 폼/라우트 체크·덮어쓰기·요청 기록 디코딩 표시·콘솔 무에러). 가이드 [10장](docs/guide/10-Mock-서버.md)·[11장](docs/guide/11-가져오기-내보내기.md) 갱신.
- **플러그인 선택기 검색·정렬(후속, 같은 날)**: [TransformPicker](frontend/src/components/TransformPicker.tsx) — 네이티브 select 대체(검색 입력 + 이름순(ko 로케일 — 한글 라벨이 영문보다 앞) 정렬 + ↑↓/Enter/Esc(문서 캡처 — 바깥 모달 안 닫힘) + id·설명 매칭). TRANSFORM 노드 속성([PropertyPanel](frontend/src/panels/PropertyPanel.tsx))과 Mock 코덱 단계 공용. 브라우저 15/15.
- **TCP mock 필드 빌더(후속, 같은 날 — "텍스트로 전문 만들기 힘들다, 한글 바이트")**: [common/tcp/TcpBytes](backend/src/main/kotlin/com/flowlink/common/tcp/TcpBytes.kt)(fixedField/prefix/hex — TcpNodeExecutor 에서 추출, 노드는 위임) +
  순수 [TcpMockEngine](backend/src/main/kotlin/com/flowlink/mock/TcpMockEngine.kt)(요청 레이아웃 슬라이싱 `MockTcp.requestFields` · 규칙 `contains` AND `when`[{field,op,value}] · 응답 `responseFields`[{name,length,value,pad,padChar,encoding}] 바이트 조립(비면 `response` 텍스트 폴백) · 템플릿 `{{req.필드}}`/`{{req}}`/`{{req:o:l}}`/`{{seq}}`/`{{now}}`/`{{uuid}}` · `preview()`). TcpMockRegistry 는 엔진 위임(구 `renderTemplate` 은 delegate — 테스트 호환), Listener 가 mockId 보유(seq). `POST /api/v1/mock-servers/tcp-preview`{tcp,sample}(저장/소켓 없음, 과대 길이 400).
  프론트 [MockTcpEditor](frontend/src/components/MockTcpEditor.tsx)(구 TcpEditor 대체 — 레이아웃 표·필드 조건·[필드|텍스트] 토글·+문자/+숫자 프리셋·`{ }` 요청 필드 삽입·미리보기 패널). 새 TCP mock 기본 spec 이 필드 모드 예시. 단위 6 + 소켓 e2e 16(EUC-KR 바이트 정확·조건 분기·텍스트 무회귀·미리보기) + 브라우저 19.
- ⚠ 코덱은 본문/전문 전체에만(헤더·콜백 본문 미적용). `./gradlew test`(루트)는 `:plugin-sample:test` 의존성 해석 실패로 깨질 수 있음 — **`./gradlew :test`** 로 앱 모듈만 실행.

## 최근 변경 (2026-09-08) — 환경(env)·실행 입력값 DB 저장 (`feat/mock-codec-transfer`)
"환경설정이나 이런거 DB에 넣게 해" — 브라우저 localStorage 개인 스코프였던 **환경(dev/staging/prod)+변수**와 **실행 입력값(플로우별 `{{키@input}}`)**을 서버 DB 로. 즐겨찾기·패널 크기·최근 사용 등 UI 취향은 localStorage 유지.
- **백엔드** `environment/` 모듈: [Environment](backend/src/main/kotlin/com/flowlink/core/domain/Environment.kt)(테넌트 스코프, `(tenant_id,name)` 유니크, `vars_json` text — V19 oracle, H2 는 ddl-auto) +
  [EnvironmentService](backend/src/main/kotlin/com/flowlink/environment/EnvironmentService.kt)/[Controller](backend/src/main/kotlin/com/flowlink/environment/EnvironmentController.kt):
  `GET /api/v1/environments` · `PUT /environments/{name}`{vars}(통째 교체, 빈 키 제거) · `POST /environments/{name}/rename`{to}(원자적, 충돌 400) · `DELETE`. **쓰기=승인 사용자**(시크릿과 같은 게이트, OIDC 는 editor — OIDC 는 2026-09-14 제거됨). 실행 입력값은 새 테이블 없이 **AppSetting `runinput:{flowId}`** — `GET/PUT /flows/{id}/run-input`{vars}(워크스페이스 롤 read/write, 빈 값=삭제). `saveAndFlush` 로 @CreationTimestamp 즉시 반영.
- **프론트**: [lib/environments.ts](frontend/src/lib/environments.ts)·[lib/runInput.ts](frontend/src/lib/runInput.ts) **저장 계층만 교체**(공개 API `useEnvStore/activeEnvVars/setEnvStore…` 불변 → EnvManager/EnvSwitcher/피커/시크릿 다이얼로그 무변경). 첫 구독/에디터 진입 시 `ensureEnvLoaded()` 로 서버 로드, 편집은 400ms 디바운스 diff(PUT/DELETE), 이름 변경은 서버 rename. **활성 환경만 브라우저**(`fl:env:active`). `Editor.onRun` 이 `ensureEnvLoaded()` 대기 후 env 주입.
  **1회 이관**: 서버가 비어 있고 구 `fl:environments`/`fl:runinput:{id}` 가 있으면 자동 업로드 + 토스트 + 구 키 삭제(게스트 등 권한 없으면 조용히 건너뜀).
- 검증: EnvironmentServiceTest 3(CRUD/rename 충돌/승인 게이트/run-input) + 전체 스위트 + 브라우저 e2e 14(API·레거시 이관 토스트·구 키 삭제·활성 유지·다이얼로그 편집 → 서버 반영·새 브라우저 컨텍스트 공유·run-input 이관) + 실행 2(`{{who@env}}` 서버 환경으로 assert SUCCEEDED). 가이드 [06장](docs/guide/06-환경-시크릿-입력.md) 갱신.
- ⚠ 환경 변수는 평문 저장(민감값은 시크릿 볼트). 동시 편집은 마지막 저장 승(LWW). 테넌트 전역이라 워크스페이스 export 에 미포함.

## 최근 변경 (2026-09-08) — DB 테이블 `flowlink_` 접두사
"db 앞에 flowlink_ 붙여줘" — 공유 스키마 충돌 방지. 15개 엔티티 `@Table(name="flowlink_…")`(app_setting·app_user·assistant_session·environment·execution·execution_suspension·flow·flow_trigger·flow_version·folder·mock_server·node_execution·secret·workspace·workspace_member).
- **Oracle**: [V20__table_prefix.sql](backend/src/main/resources/db/migration/oracle/V20__table_prefix.sql) — `ALTER TABLE x RENAME TO flowlink_x` ×15(FK/인덱스 자동 추종, V1~V19 는 그대로 — 체크섬 불변). 새 DB 도 V1~V19 후 V20 으로 같은 최종 상태.
- **H2 dev**: [TablePrefixMigration](backend/src/main/kotlin/com/flowlink/common/db/TablePrefixMigration.kt) — **Hibernate(ddl-auto) 전에** 구 테이블을 이름 변경(기존 `.mv.db` 데이터 보존). `EntityManagerFactoryDependsOnPostProcessor` 로 EMF 가 이 빈에 의존. 규칙: 구만 있음→RENAME · 구/신 둘 다(이전 기동이 빈 flowlink_* 를 먼저 만든 경우)→**데이터 있는 구가 승**(신 DROP CASCADE 후 RENAME, 신의 부트스트랩 행 수 WARN) · 구가 빈 테이블→구 DROP. 첫 구현은 "신 존재 시 건너뜀"이라 실데이터가 옛 테이블에 고아로 남는 사고가 났었음(백업 `~/flowlink-h2db/flowlink.mv.db.bak-before-prefix`) → 위 규칙으로 복구 확인. AppSettingSchemaFix/MockServerSchemaFix/RetentionServiceTest 의 raw SQL 도 새 이름.
- 검증: 전체 스위트 그린 + 라이브(:8888 기존 H2 파일 — 기동 로그에 테이블별 행 수(flow 54·execution 1267·node_execution 10511 …)와 함께 이관, API flows 26·mocks 8·executions 200 이 접두사 전과 동일, 접두사 없는 테이블은 레거시 `user_account` 만 잔존). Flyway 이력 테이블은 기본 이름 유지(운영가이드 §3).
- ⚠ 새 테이블을 추가할 땐 `@Table(name="flowlink_…")` + Oracle 마이그레이션도 접두사 이름으로(구 이름 목록엔 넣지 않아도 됨).

## 최근 변경 (2026-09-08) — Mock 2.0: 코덱 v2(범위·입력 포트·시크릿) · 통합 템플릿 · 예상 요청+칩 · 요청 기록 활용
설계: [docs/superpowers/specs/2026-09-08-mock-codec-v2-design.md](docs/superpowers/specs/2026-09-08-mock-codec-v2-design.md). 사용자 피드백("왜 니맘대로 — 일부 필드/전체 선택, key·iv 입력, env·vault, Mock 도 편하게, 칩은 올 것을 미리 정의"). **환경 변수(@env)는 Mock 에 넣지 않음(사용자 결정)** — 시크릿만.
- **통합 템플릿 [MockTemplate](backend/src/main/kotlin/com/flowlink/mock/MockTemplate.kt)** + `MockContext`(req·pathParams·seq·state·secrets·TCP req/fields·json): 워크플로 칩 문법 `{{ x@body|query|path|header|state|secret|req }}` 와 기존 dot 문법(`{{body.x}}`·`{{req:o:l}}`) 모두 해석, body 는 **점 경로**(`user.addr.city`, `items[0].id`, 최상위 실키 우선). MockRuntime(render/conditionsPass)·TcpMockEngine·MockCodec 이 공유. `JsonPaths` get/setText.
- **시크릿**: `MockSpec.environment` = 시크릿 스코프(공통+Vault(2026-09-14 제거됨)+그 환경 오버레이). [MockSecretProvider](backend/src/main/kotlin/com/flowlink/mock/MockSecretProvider.kt)(tenant+env 10초 캐시, 실패 시 빈 맵 WARN). 게이트웨이/TCP 리스너가 `TenantContext` 를 Mock 소유 테넌트로 설정. **요청 기록(headers/body/decodedBody) 시크릿 마스킹**(SecretMasker), 응답은 의도된 출력이라 마스킹 안 함.
- **코덱 v2 [MockCodec](backend/src/main/kotlin/com/flowlink/mock/MockCodec.kt)**: 단계 `{id, target: body|fields|header, fields[], header, inputs[{key, mode: message|value, value}], config, outputKey}`(v1 `{id,config,inputKey,outputKey}` 호환). `applyStep`(입력 포트 message 1개 + value 템플릿, config 템플릿) · `applyRequest`(body 체인 / fields=JSON 점경로·urlencoded 값만 재직렬화 / header 값 변환) · `applyResponse`(fields / **header=본문 입력→헤더 기록(서명)** / body) · TCP `applyTcpField`(패딩 전)·`applyTcpBody`. fields 는 JSON/urlencoded 만(그 외 CodecException). `StepTrace` 로 단계 기록.
  MockRuntime.render 에 `ResponseCodec` fun interface(본문+헤더 맵+contentType) + secrets/json 파라미터. [TcpMockEngine.process](backend/src/main/kotlin/com/flowlink/mock/TcpMockEngine.kt)(요청 body/fields 코덱 → 매칭 → 렌더(필드 코덱) → 응답 body 코덱) 를 리스너·미리보기가 공유(`preview` 에 codec/secrets, `decodedRequest`·`codecSteps`).
- **API**: `POST /mock-servers/{id}/codec-try`{codec, environment, side, message, headers, contentType} → {result, headers, fields, steps}(승인 사용자 + 읽기 권한, 시크릿 값 마스킹) · `tcp-preview` 에 codec/environment. `MockRoute.expect{body,query,header:[{key,type,example}]}`(예상 요청 — 실행 의미 없음). `MockHttp.parseBodyFields` 로 이동(게이트웨이·코덱 공용).
- **프론트**: [MockCodecEditor](frontend/src/components/MockCodecEditor.tsx) v2(범위 세그먼트·필드 datalist·헤더명·**입력 포트 라디오(전문/값)+TokenInput**·파라미터 TokenInput·🧪 코덱 시험해보기) · [MockRouteEditor](frontend/src/components/MockRouteEditor.tsx)(RoutesEditor/RouteCard/RuleCard 를 MockServerEditor 에서 분리 — 예상 요청 편집기·요약 배지·**▶ 규칙 테스트**(매칭 규칙 확인)·응답 헤더 KV·setState/콜백 URL TokenInput·본문/콜백 본문 `{ }` 삽입·조건 키 datalist) · [lib/mockSources](frontend/src/lib/mockSources.ts)(피커 소스: 경로/쿼리/헤더/본문(expect)·상태·시크릿·TCP 요청 필드, `insertAtCaret`) · [lib/mockRequestLog](frontend/src/lib/mockRequestLog.ts)(matchPath 미러·mergeExpect·bodyKeys·interestingHeaders) · RuntimePanel 액션 **[예상 필드로]/[규칙 초안]/[재전송]** · 편집기 상단 🔑 시크릿 환경 셀렉트 · TokenInput 이 캔버스 밖 소스 이름/색(`sources`)으로 칩 라벨 · BindableItem.tag(피커 태그 덮어쓰기). MockSchemaPrompt(AI) 갱신.
- 검증: 단위(MockTemplate 6·MockCodecV2 7 + 기존) + 전체 스위트 그린 + **라이브 e2e 14**(fields 코덱 pin/**AES card.no key·iv 시크릿 포트**/헤더 디코딩·점경로·응답 필드 인코딩·**HMAC X-Signature(dev 시크릿 오버레이) 검증**·라우트 `{}` 무효화·journal 마스킹·codec-try 3·TCP fields+body+시크릿 필드·tcp-preview 코덱·v1 호환) + 브라우저(시크릿 환경 셀렉트·요청 기록→예상 필드로·피커 소스 5종·본문 캐럿 삽입·헤더 칩·조건 datalist·코덱 헤더 대상+파라미터 칩+시험해보기·저장 후 서빙 X-Auth/X-Sig·규칙 초안). 가이드 [10장](docs/guide/10-Mock-서버.md) 재작성.
- ⚠ 코덱 fields 대상은 JSON/urlencoded 본문만. codec-try 는 시크릿을 간접 노출할 수 있어 승인 사용자 게이트. Mock 시크릿 캐시 10초(저장 직후 반영 지연 가능). 예상 요청(expect)은 문서일 뿐 매칭에 영향 없음.

## 최근 변경 (2026-09-09) — Mock 을 제품 수준으로: 목록 대시보드화 · 편집기 좌목록/우상세/하단트래픽 · 버전 기록
"워크플로는 거의 제품인데 Mock 도 그렇게" 요청. 3단계(목록 → 편집기 구조 → 버전 기록) 전부 구현.
- **백엔드**: [MockServerSummary](backend/src/main/kotlin/com/flowlink/mock/MockDtos.kt) 에 spec 요약(routeCount/methods/paths/tcpPort/tcpEnabled/hasCodec/environment — `updatedAt` 키 digest 캐시) + 살아있음 지표(journal 기반 lastRequestAt/recentRequests(60초)/requestCount) + currentVersion. `GET /mock-servers/usages`(이 Mock 의 `/mock/{slug}` 를 현재 그래프에 가진 워크플로 — 테넌트별 30초 인덱스 캐시, 읽기 가능 워크스페이스만). `PATCH` 에 `workspaceId`(이동, 양쪽 쓰기 권한).
  **버전 기록**: [MockServerVersion](backend/src/main/kotlin/com/flowlink/core/domain/MockServerVersion.kt)(`flowlink_mock_server_version`, V21 + `flowlink_mock_server.current_version`) — 생성 v1, `PUT /spec`{spec, note, pinned} 은 **내용이 바뀌었을 때만** 스냅샷, `GET /{id}/versions`·`/versions/{no}`·`POST …/restore`(새 버전+서빙 즉시 반영)·`PUT …/pin`. mock 당 최근 50개 유지(📌 제외), 삭제 시 cascade. [MockServerVersionTest](backend/src/test/kotlin/com/flowlink/mock/MockServerVersionTest.kt) 3종.
- **목록** [MockServers](frontend/src/routes/MockServers.tsx): 검색(`/`·Ctrl+F, 경로/포트 포함)·정렬·필터 세그먼트·즐겨찾기(`fl:mockfav:{ws}`)·선택 모드(일괄 켜기/끄기/삭제)·카드(메서드 칩·살아있음 점·마지막 요청·↗ 워크플로 N 팝오버·코덱/환경/vN 배지)·⋯ 메뉴(즐겨찾기/이름/복제/내보내기/워크스페이스 이동/삭제). 5초 폴링(살아있음).
- **편집기** [MockServerEditor](frontend/src/routes/MockServerEditor.tsx) 재작성: 헤더(이름 인라인·미저장·자동 저장 `fl:mock:autosave`·Ctrl+S·이탈 경고·🕘 버전·⋯ 도구·JSON 모달·단축키) | **좌 nav**(라우트 목록: 메서드·경로·히트 배지·드래그 정렬·검색 / TCP 전문 / 전문 코덱 ON / 설정 / 개요) | **우 상세**(선택 라우트 = [RouteCard](frontend/src/components/MockRouteEditor.tsx) export, TCP 편집기, 코덱, 설정(서빙 주소·시크릿 환경·OpenAPI·이동·위험 구역), 개요 타일) | **하단 트래픽**(요청 기록 3초 폴링·무매칭 빨강·라우트 필터·예상 필드로/규칙 초안/재전송·상태 요약·보내보기 탭). [MockVersionHistoryDialog](frontend/src/components/MockVersionHistoryDialog.tsx) + [lib/mockDiff](frontend/src/lib/mockDiff.ts)(라우트 id 대조 diff). OpenAPI 변환은 [lib/mockOpenApi](frontend/src/lib/mockOpenApi.ts) 로 분리.
- 검증: 백엔드 전체 스위트 + API e2e(요약 통계·usages·버전 list/get/restore/pin·동일 내용 스킵·cascade) + 브라우저(목록 툴바/검색/필터/즐겨찾기/이름변경/일괄 끄기 · 편집기 nav/히트/상세 전환/미저장·Ctrl+S/JSON/버전 diff·복원/이탈 경고/설정/트래픽 규칙 초안 · TCP nav) + 기존 스위트 재적응. 가이드 10장 목록/편집기/버전 섹션 재작성.
- ⚠ usages 는 현재 그래프 문자열 매칭(`/mock/{slug}` 경계) — env 변수로 base URL 을 넣은 워크플로는 못 잡음. 살아있음 점은 journal(최근 100건) 기준.

## 최근 변경 (2026-09-09) — Mock: HTTP/TCP 완전 분리 · 필드에서 시작하는 코덱 UX · 대시보드 목록
"HTTP 는 HTTP 만, TCP 는 TCP 만 / 코덱 필드 설정까지 가는 길이 멀다 / Mock 목록을 대시보드처럼" 요청. 전부 프론트 재구성 + 백엔드는 요약 필드·TCP 전문 기록만.
- **백엔드**: [TcpMockRegistry](backend/src/main/kotlin/com/flowlink/mock/TcpMockRegistry.kt) 가 TCP 전문도 **journal 에 기록**(`method="TCP"`, `path=":포트"`, headers `bytes`/`response-bytes`, bodyText=디코딩 전문(시크릿 마스킹), 무매칭=404, 요청 코덱이 있으면 decodedBody) — 편집기 히트/트래픽 패널·목록 살아있음 점이 TCP 에도 동작. [MockServerSummary](backend/src/main/kotlin/com/flowlink/mock/MockDtos.kt) 에 `routeLabels`("GET /pay" 앞 8개)·`tcpRuleCount`·`tcpFieldCount`·`unmatchedRequests`(journal 의 matchedRuleId==null 수).
- **A. 분리** — [MockServers](frontend/src/routes/MockServers.tsx): `🌐 HTTP Mock | 🔌 TCP Mock` 탭(`fl:mock:tab`, 개수 배지+살아있음 점), `+ HTTP Mock`/`+ TCP Mock` 별도 생성, 유형 필터 제거. [MockServerEditor](frontend/src/routes/MockServerEditor.tsx): `NavSel` = route | **conn · layout · rule(id)** | codec | settings | overview — HTTP 편집기(라우트 목록 · 본문·헤더 코덱 · 설정 · 개요) / TCP 편집기(연결 · 요청 레이아웃 · **규칙 목록=노드**(조건 요약·응답 바이트·히트·드래그 정렬) · 전문 코덱 · 설정, 우측=규칙 상세). **"사용" 체크박스 제거**(TCP Mock 은 켜짐=리스너; 복제본은 `tcp.enabled=false` 로 만들어지고 연결 pane 안내 [리스너 켜기]). 하단 트래픽 = HTTP `[요청 기록 | 보내보기]` / TCP `[전문 기록 | 🔍 전문 미리보기]`(기록 행 → [이 전문으로 미리보기]). **레거시(HTTP Mock 에 tcp 섹션 혼합)**: 상단 배너 + [TCP Mock 으로 분리](`splitTcp` — 새 `{slug}-tcp` TCP Mock 생성 → 원본 tcp 제거 저장(리스너 닫힘) → 새 Mock 에 tcp 저장(같은 포트로 열림) → 이동). [MockTcpEditor](frontend/src/components/MockTcpEditor.tsx) 는 조각으로 분해: `TcpConnectionPanel`·`TcpLayoutPanel`·`TcpRuleDetail`·`TcpPreviewPanel`(제어형 sample)·`defaultTcpSpec/defaultTcpRule/tcpRuleSummary`.
- **B. 코덱 UX(필드에서 시작)** — [lib/mockCodecOps](frontend/src/lib/mockCodecOps.ts)(순수: `stepsForField/addStep/replaceStep/removeStep/detachField/stepCount/summarizeStep/responseBodyKeys`) + [FieldCodecButton](frontend/src/components/FieldCodecButton.tsx): 필드 옆 **◈** → 팝오버([⬇ 요청 전 풀기 | ⬆ 응답 후 감싸기] → TransformPicker → 입력 포트/파라미터 TokenInput(키·IV 시크릿 칩)) → `target:'fields'` 단계 생성, 필드에 `◈ ⬇ AES 복호화` 배지(클릭=수정/이 필드에서 제거). 적용처: HTTP 예상 요청 본문 필드(양방향)·규칙 응답 JSON 키 칩(`responseBodyKeys`, 응답 후)·TCP 요청 레이아웃(요청 전)·TCP 응답 필드(응답 후). 단계는 **그 라우트에 실제 적용되는 코덱**에 쌓임 — [RouteCard](frontend/src/components/MockRouteEditor.tsx) `effCodec` = route.codec(라우트 전용) ?? spec.codec(`onServerCodec` 콜백), 상단 **◈ 코덱 요약 한 줄**(서버 코덱/이 라우트만 · 요청 전 N · 응답 후 M · 편집/코덱 화면 →). [MockCodecEditor](frontend/src/components/MockCodecEditor.tsx): 단계 카드 **접힌 한 줄 한국어 요약**(`summarizeStep` — "응답 후 · pin 필드 → Base64 인코딩 (key: 🔑 aesKey)", 미설정은 빨간 테두리) + 펼쳐서 편집(필드 체크박스 칩 + 직접 입력), **+ 단계 = 위저드**(`CodecStepWizard`: ① 언제 ② 무엇을(전체/특정 필드 체크/헤더) ③ 플러그인 ④ 값). `RoutesEditor` 제거(RouteCard 만).
- **C. 대시보드 목록**: **현황 스트립**(전체·서빙 중/리스너 열림·요청 들어오는 중·무매칭 요청 있음 — 클릭=필터 토글), **⚡ 최근 트래픽**(lastRequestAt 순 5개), **2열 카드**(`repeat(auto-fill, minmax(440px,1fr))`) — HTTP 는 base URL + **라우트 미니 스트립**(메서드 색 점+경로, `+N`), TCP 는 `:포트`+요청 필드/규칙/코덱 필, 푸터에 무매칭 N·↗ 워크플로·vN. 즐겨찾기/검색/정렬/선택 모드 유지(현재 탭 스코프).
- 검증: 백엔드 전체 스위트 그린 + API e2e 17/14/15/16 무회귀 + 브라우저 신규 **split.mjs 47**(탭·현황 필터·미니 스트립·최근 트래픽·◈ 팝오버→배지→요약→서빙 end-to-end(요청 base64 풀기+응답 감싸기)·위저드 필드 체크·TCP nav/연결/레이아웃 ◈·미리보기 탭·실제 TCP 전문 → 전문 기록 행·레거시 분리) + 기존 product 25·ui 18·codecv2 17·tcp 20·picker 15 재적응. 가이드 10장 재작성(목록·HTTP/TCP 편집기·코덱 "필드에서 시작").
- ⚠ TCP 사용처(↗ 워크플로)는 자동 감지 안 함(HTTP base URL 만). 응답 필드 칩은 규칙 본문이 JSON 일 때만(깊이 3·40개). 같은 필드의 ◈ 는 예상 요청·응답 칩 양쪽에 같은 배지를 보인다(한 코덱). 레거시 분리는 되돌리기 없음(버전 기록으로 원본 spec 복원 가능).

### 큰 편집기 IDE 급 — 정렬(js-beautify) · 미리보기(샌드박스 iframe/JSON 트리) · `{{` 자동완성 (2026-09-09, 사용자: "HTML 편집기 자동정렬·IDE급·미리보기")
가벼운 쪽(js-beautify, prettier 아님 — 사용자 선택)으로. 전부 프론트, 편집기 lazy 청크 안에서만 커짐(본 번들 무변화).
- **[lib/codeFormat](frontend/src/lib/codeFormat.ts)**(순수): `protectTokens`(`{{…}}` → `__FLTKn__` 식별자 자리표시자 → 복원) · `formatWithTokens(text, fmt)` · `formatJson`(파싱→2칸; **따옴표 없는 토큰**(`"n": {{ x@body }}`)은 자리표시자를 문자열로 감싸 파싱하고 원래 bare 였던 것만 따옴표를 벗김) · `formatCode(text, lang, beautifyHtml)`. 실패는 null(원문 유지).
- **[lib/templatePreview](frontend/src/lib/templatePreview.ts)**(순수): `parseTemplateToken`(칩 `{{ k@src }}`·dot `{{body.k}}`/`{{req.k}}`·내장 uuid/seq/now/body/req·`{{req:o:l}}` → 정규화 id `k@src`) · `templateTokens`(중복 제거) · `renderTemplatePreview(text, samples)`(샘플 `k@src` → `k` → 내장 → `«k»`) · `previewDocument`(fragment 를 문서로 감싸고 `<base target="_self">`).
- **[CodeEditor](frontend/src/components/CodeEditor.tsx)**: forwardRef 핸들 `format()/focus()`, `Shift-Alt-f` 키맵, js-beautify html(2칸·inner html 들여쓰기, xml 도 같은 포맷터), **`EditorState.languageData` 전역 자동완성**(`{{` 뒤 — sources 의 `{{ key@sourceId }}` + 내장, HTML 안의 JS/CSS 에서도 동작), 줄바꿈 Compartment, `onStatus`(줄:열·선택·줄 수). 명시 deps `@codemirror/state·view·autocomplete` 추가.
- **[BigTextEditor](frontend/src/components/BigTextEditor.tsx)**: 툴바 `⇥ 정렬 · ↩ 줄바꿈 · 👁 미리보기`(localStorage `fl:bigedit:wrap/preview`) + 하단 상태바/단축키 안내. `PreviewPane`: HTML = `<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups">`(same-origin 없음 — 앱 세션·쿠키 접근 불가) srcDoc 300ms 디바운스 / JSON = JsonTree; **샘플 값** 폼(문서의 토큰 목록, 내장은 자동, 호출처 `samples` 초기값). props `sources`(자동완성)·`samples`.
  호출처: [MockRouteEditor](frontend/src/components/MockRouteEditor.tsx) 규칙 본문/콜백 본문에 `sources` + `sampleValuesFor(route)`([mockSources](frontend/src/lib/mockSources.ts) — 예상 요청 예시값 `k@body/query/header`, 경로 파라미터 `=1`, `body`=예시 JSON) · [PropertyPanel](frontend/src/panels/PropertyPanel.tsx) raw 바디/콜백 응답에 `sources`(상위 노드 출력).
- **[useEscapeClose](frontend/src/components/useEscapeClose.ts)**: `e.defaultPrevented` 면 무시 — CodeMirror 가 처리한 Esc(검색 패널·자동완성 닫기)가 모달까지 닫지 않게.
- **현재 일시 토큰(후속, 사용자: "현재 일시 같은 거 쓸 수 있나 → 전체 다")** — [common/text/NowTokens](backend/src/main/kotlin/com/flowlink/common/text/NowTokens.kt)(순수): `now`(ISO UTC, 기존 규약) · `now:패턴`(Java DateTimeFormatter, **기본 KST**, Locale.KOREA — `a`=오전/오후, `E`=요일) · `today`(yyyyMMdd) · `time`(HHmmss) · `@타임존`(ZoneId — `now:yyyyMMdd@UTC`, `now@Asia/Seoul`=그 타임존 ISO 오프셋). 잘못된 패턴은 null→빈 값.
  **Mock**: [MockTemplate.resolve](backend/src/main/kotlin/com/flowlink/mock/MockTemplate.kt) 0단계 `NowTokens.resolveExpr`(AT 매칭보다 먼저 — `now@UTC` 가 소스 참조로 오인되지 않게; `time@body` 는 ZoneId 가 아니라 소스 참조로 흘러감). 응답 본문·헤더·setState·콜백·TCP 응답 필드·코덱 값 전부.
  **워크플로**: [TokenResolver](backend/src/main/kotlin/com/flowlink/execution/engine/TokenResolver.kt) TOKEN 정규식에 시각 토큰 갈래 추가(`(?:now|today|time)(?::[^@{}\s][^@{}]*?)?` — 패턴에 공백·`:`·`'` 허용, 그룹 번호 1/2/3 불변 → ExpressionEvaluator·프론트 소비자 무변경) + `timeToken/timeObject` 훅(resolveTokens·resolveTokenObject·resolveLiteral·조건식): **bare `now/today/time` 은 상위 노드에 같은 키가 있으면 그것이 우선**(기존 의미 보존), 패턴형은 항상 시각, `@id` 는 `NowTokens.isZone` 이면 타임존 아니면 노드 id. 프론트 [tokenGrammar](frontend/src/lib/tokenGrammar.ts) 미러(칩 렌더·segmentValue 동일).
  **프론트**: [templatePreview](frontend/src/lib/templatePreview.ts) `formatNow`(y M d H h m s S a E + '리터럴', KST/UTC/±hh:mm — 지역명은 KST 근사) 로 큰 편집기 미리보기 치환, [CodeEditor](frontend/src/components/CodeEditor.tsx) `{{` 자동완성 내장 목록(today/time/now:패턴/@UTC). MockSchemaPrompt(AI) 갱신.
  검증: NowTokensTest 3(고정 Instant — KST/UTC 날짜 경계·타임존·판별·오류) + TokenResolverTest `nowTokens`(상위 키 우선·노드 id vs 타임존·`timeout` 무영향·빈 패턴은 토큰 아님) + MockTemplateTest + 프론트 단위 5 + 라이브 e2e(Mock HTTP 본문/헤더·TCP 응답 필드 today/time·워크플로 SET/조건식/HTTP 헤더·raw 본문 → mock 에코). 가이드 [04장](docs/guide/04-토큰-바인딩.md)·[10장](docs/guide/10-Mock-서버.md) 표에 추가.
  ⚠ 워크플로 토큰의 타임존은 sourceId 클래스 `[\w-]` 라 `UTC`/`GMT` 같은 단어형만(`Asia/Seoul`·`+09:00` 은 Mock 템플릿에서만). 상위 노드 출력에 `now`/`today`/`time` 키가 있으면 bare 토큰은 그 값(패턴을 붙이면 시각). 미리보기 `formatNow` 는 근사(DST 지역·드문 패턴 글자는 서버와 다를 수 있음).
- **키 스코프(후속, 사용자: "Tab·Ctrl+Z 스코프")**: `indentWithTab`(Tab=들여쓰기, 포커스 이탈 없음 — basicSetup 기본은 접근성 때문에 빠져 있음) · Ctrl+Z/Y 는 CM 히스토리(빈 히스토리면 preventDefault 안 해 바깥으로 가지만 [Editor](frontend/src/routes/Editor.tsx) 전역 핸들러가 contentEditable 가드로 무시) · **텍스트 모드도 CodeMirror**(언어 확장만 없음 — Tab/undo/찾기/자동완성/placeholder 동일, 평문 textarea 는 Suspense 폴백만) · [FlowCanvas](frontend/src/canvas/FlowCanvas.tsx) Ctrl+K 빠른 추가에 입력 필드 가드 추가(유일하게 가드가 없던 전역 단축키). Delete/Backspace·방향키·Ctrl+A/D/F 는 기존 가드(RF isInputDOMNode·Editor inField)로 이미 편집기 안에서 무시. 브라우저 keyscope 스위트 18(Tab/Shift+Tab/Ctrl+Z·Y 편집기 내부·텍스트 모드 CM·워크플로 안에서 Ctrl+K/Delete/방향키/Ctrl+Z/Ctrl+A 캔버스 무간섭).
- 검증: 순수 단위 11(토큰 보호/JSON bare 토큰/정규화/치환/문서 감싸기) + 브라우저 bigedit 스위트(정렬 결과·토큰 보존·CSS/JS 정렬·noop·미리보기 srcdoc 치환+base+sandbox 속성·iframe 안 DOM/스크립트·샘플 수정 재렌더·`{{` 자동완성 목록/Enter 삽입·실시간 미리보기·Esc 스택·JSON 정렬/트리·닫은 뒤 반영) + tsc/lint/build. 가이드 10장 "큰 편집기" 절 추가.
- ⚠ 미리보기 iframe 에서 폼 제출/링크는 iframe 안에서 이동(외부 URL 로 실제 요청이 나갈 수 있음 — 샘플 값 주의). 정렬은 문법이 깨진 문서엔 실패(원문 유지). JSON 미리보기는 따옴표 없는 토큰의 샘플 값이 숫자여야 파싱된다. XML 정렬은 html 포맷터라 self-closing/namespace 가 특이한 문서는 결과 확인 필요.

## 최근 변경 (2026-09-09) — context path 배포(`FLOWLINK_CONTEXT_PATH=/flowlink`) — 앱 전체가 경로 접두사 밑에서
"상대 경로/context path 되나?" → 안 되던 것을 **앱이 접두사를 아는 방식(1안)** 으로. 접두사를 벗기는 프록시(`X-Forwarded-Prefix`) 방식은 미지원(의도).
- **백엔드**: `server.servlet.context-path: ${FLOWLINK_CONTEXT_PATH:}`(application.yml — Spring 규약 `/flowlink`, 앞 슬래시 필수·끝 슬래시 없음). [SpaStaticConfig](backend/src/main/kotlin/com/flowlink/common/web/SpaStaticConfig.kt) 가 `index.html` 의 `<base href="/">` 를 `<base href="{ctx}/">` 로 **1회 변환해 캐시**(루트 WelcomePage forward 와 SPA fallback 양쪽 — `rewriteBase` 순수). [RelayBaseResolver.requestOrigin](backend/src/main/kotlin/com/flowlink/settings/RelayBaseResolver.kt) 이 `contextPath` 를 포함(콜백 수신 URL `…/flowlink/relay/…`, ⚙ 설정 auto 값). [MockGatewayController](backend/src/main/kotlin/com/flowlink/mock/MockGatewayController.kt) 는 `requestURI` 에서 context path 를 뗀 `pathInApp` 으로 slug 파싱(안 떼면 `/flowlink/mock/…` 가 slug 로 오인). 컨트롤러 매핑·SecurityConfig·WS 핸들러는 Spring 이 context-relative 라 무변경.
- **프론트**: Vite `base: './'`(상대 자산) + `index.html` 에 `<base href="/" />`(dev 는 그대로 `/`) → [lib/appBase](frontend/src/lib/appBase.ts) `appBase()`(=`document.baseURI` pathname, `''` 또는 `/flowlink`)·`appUrl(path)` 가 유일한 접두사 소스. 적용: `BrowserRouter basename`, axios `baseURL`(`{ctx}/api/v1`), presence WebSocket(`{ctx}/ws/presence`), `mockBaseUrl`(화면의 Mock base URL·보내보기·▶ 테스트·재전송), TriggersDialog 웹훅 URL. RunPanel 테스트 콜백은 수신 URL 의 pathname 을 그대로 써서 이미 접두사 포함. favicon 은 `./favicon.svg`.
- **scripts**: `start/status.(ps1|sh)` 가 `FLOWLINK_CONTEXT_PATH` 를 정규화(`flowlink`·`/flowlink/` → `/flowlink`)해 앱에 넘기고 health URL(`…/flowlink/api/v1/auth/config`)도 접두사로. ⚠ Git Bash 에서 `FLOWLINK_CONTEXT_PATH=/flowlink java …` 로 직접 띄우면 **MSYS 경로 변환**이 `/flowlink` 를 `C:/Program Files/Git/flowlink` 로 바꿔 기동 실패("ContextPath must start with '/'") — `MSYS_NO_PATHCONV=1` 또는 scripts 사용.
- 검증: `/flowlink` 인스턴스(:18082) 브라우저 스위트 **24**(index `<base>`·상대 자산 로드·루트 404·딥링크 fallback·API 미fallback·health·relay auto/effective·Mock 서빙 접두사/루트 404·SPA 부팅 리다이렉트·목록/편집기 라우팅·새로고침·헤더/설정의 Mock base URL·보내보기 200·presence WS URL·트리거 다이얼로그·**wait 수신 URL 접두사 → 콜백 POST → SUCCEEDED**·콘솔/4xx 0) + 루트 인스턴스(:18081) 무회귀(product 25·ui 18) + 백엔드 전체 스위트. 운영가이드 §3 에 env·프록시 구성 규칙.
- ⚠ 접두사를 주면 루트(`/`)는 404(Spring 규약). 프록시는 접두사를 **유지한 채** 전달해야 한다. `appBase()` 는 `<base href>` 가 있어야 정확 — 다른 정적 서버로 dist 를 직접 서빙하면 `<base href>` 를 직접 맞출 것.

## 최근 변경 (2026-09-10) — Mock 화면 = 서버 인벤토리(행 목록) 하나: 워크스페이스 그룹 · 포트 스트립 · 읽기 전용 · fleet API
"Mock 을 엔터프라이즈(n8n) 느낌으로 — 내 워크스페이스가 아니어도 실제 서버처럼 뭐가 떠 있는지, 워크스페이스로 묶고, 포트가 잘 보이게, 내 것이 아니면 읽기 전용, **목록은 없애고 그게 목록 기능을 다 가질 것**" 요청.
시각안 3개(워크스페이스 타일 → 2.5D 서버 아이콘 토폴로지 → React Flow 포트 중심 노드 맵)가 차례로 반려된 뒤 **4 에이전트 토론**(그래프 선은 소속 외 정보가 없고, 팬/줌이 스크롤을 뺏고, 호버 도구·자동 배치로는 목록을 대체 못 함 → 그래프 폐기) → 사용자가 **행 인벤토리**(Docker Desktop/Mockoon 식)를 선택. React Flow 토폴로지(`MockTopology`)는 삭제.
- **백엔드** `GET /api/v1/mock-servers/fleet`([MockServerService.fleet](backend/src/main/kotlin/com/flowlink/mock/MockServerService.kt), DTO [MockDtos.MockFleet](backend/src/main/kotlin/com/flowlink/mock/MockDtos.kt)) — 테넌트의 **모든** 워크스페이스([WorkspaceService.listAll](backend/src/main/kotlin/com/flowlink/workspace/WorkspaceService.kt) + `isMember`) × 모든 Mock 을 한 응답에:
  `FleetWorkspace{id,name,kind,myRole(null=접근 불가),mine(멤버십 기준 — 관리자 OWNER 우회와 별개)}` · `FleetServer{…, readable, myRole, listening(실제 소켓), listenError, usedBy[FlowRef](readable 만 — `usageIndex()` 테넌트 30초 캐시를 `usages()` 와 공유), …}` · `FleetPort{port,kind HTTP|TCP,state LISTENING|FAILED|OFF,…}`(HTTP 게이트웨이=앱 포트(`local.server.port`→`server.port`)+켜진 HTTP 수, TCP 는 mock 별 — HTTP 먼저·포트순) · `httpPort`·`contextPath`.
  **접근 불가 워크스페이스의 Mock 은 이름·slug·종류·켜짐·포트·살아있음·개수만**(routeLabels/environment/usedBy 비움) — 서빙 주소·TCP 포트는 전역 자원이라 점유를 누구나 알아야 하고, 정의는 여전히 roleFor 게이트. [TcpMockRegistry](backend/src/main/kotlin/com/flowlink/mock/TcpMockRegistry.kt) 에 `listeningPort(id)`/`bindFailure(id)`(기동 시 바인딩 실패를 기억 — 저장 시 실패는 400 롤백이지만 재기동 실패는 조용했음 → 빨간불).
- **프론트** [MockServers](frontend/src/routes/MockServers.tsx) — **목록/카드/HTTP·TCP 탭/워크스페이스 셀렉트/보기 전환 없음**(구 `MockFleetView`·`ServerIcon`·`MockTopology` 삭제). 페이지 = 헤더(⬇ 가져오기 · + HTTP/TCP Mock — 만들기 행에 **대상 워크스페이스 select**(`fl:workspace` 기억), slug 실시간 검사) → 현황 스트립 6(서버·서빙 중·열린 포트·요청 들어오는 중·무매칭·워크스페이스 — 4개는 클릭=필터) → 툴바(검색 `/`·필터 세그먼트 전체/켜짐/꺼짐/요청 중/★·`N/M 일치`·☑ 선택 + 일괄 바(켜기/끄기/이동 select/삭제, 모두 선택=검색 일치 중 편집 가능)) → [MockInventory](frontend/src/components/MockInventory.tsx). 즐겨찾기 `fl:mockfav`(전역 1키). 행 작업은 `onAction(server, action, arg)` 한 콜백(toggle/rename(AskDialog)/duplicate/export(MockExportDialog)/delete/fav/copyUrl/move/goFlow).
  **MockInventory**(순수 DOM, RF 없음): ① **포트 스트립**(`aria-label="포트 맵"` — HTTP 게이트웨이 칩 + TCP LISTENING/FAILED 칩, OFF 는 `▸ 꺼짐 N` 토글 뒤; 칩 클릭 = `#mock-row-{id}` 로 `scrollIntoView` + `.fl-row-flash`) ② **워크스페이스 그룹** `section[aria-label="워크스페이스 {name}"][data-mine]`(정렬 mine→공용/개인/팀→이름, 서버 0 인 남의 그룹은 숨김; 헤더 = ▾/▸(`aria-expanded`, 접힘은 `fl:mock:groups` localStorage, 기본 mine 펼침/남의 것 접힘, 검색 중엔 `shown.length===0` 이면 접힘)·아이콘·이름·롤 칩·`서버 N(/M) · 서빙 · 요청 중`·TCP 포트 미니(6개+N)·**+ Mock**(`onCreateIn`)) ③ **행** `.fl-mock-row#mock-row-{id}`(`data-state on|off|fail`·`data-kind`·`data-readable`·`data-selected`, `role=button`+`tabIndex`+Enter): 그리드 `14px | 포트+주소 | 이름 | 종류·상태 | 구성 | 트래픽 210 | ↗ | vN | 도구`(minWidth 1000, 가로 스크롤 컨테이너) — LED(`.fl-led-live` 펄스는 `recentRequests>0` 만)·`.fl-port`(15px 굵게, kind 색)·경로/호스트·이름(★)·kind 태그+상태 라벨(`!` 실패, 🔒 읽기 전용/접근 없음)·구성(라우트 필 3+N / `필드 N · 규칙 M` / ◈ / 🔑env / 접근 없음이면 "정의 비공개")·트래픽(`● N건/60초 · relTime · 무매칭 N`)·`↗N`(title=워크플로 이름)·`vN`·**⏻**(`aria-label="{name} 켜기|끄기"`, editable 만)·**⋯**(`aria-label="{name} 작업 메뉴"`, readable 만 — `role=menu` 즐겨찾기/URL 복사/켜기끄기/이름/복제/내보내기/↗ 워크플로 펼침/이동 select/삭제/선택; 도구 컨테이너가 click·mousedown `stopPropagation`). 행 클릭: selectMode·Ctrl/Shift → 선택, 아니면 readable 만 편집기. off=opacity .6, 검색/필터 비매칭은 **숨김**(dim 아님). `serverState()`(TCP: listening→on / listenError→fail / off, HTTP: enabled) 는 여기서 export.
  CSS([index.css](frontend/src/index.css)): `.fl-led-live`(펄스), `.fl-row-flash`(1회 배경 플래시, reduced-motion 정지), `.fl-mock-row:hover/:focus-visible`. 구 `fl-node-glow`/`fzone`/`fspine`/`fl-topology` 규칙 삭제.
- 검증: [MockFleetTest](backend/src/test/kotlin/com/flowlink/mock/MockFleetTest.kt)(JWT 심기 — 비멤버 readable=false·라우트 비움·개수 노출, VIEWER readable+정의, OWNER, TCP 리스너 LISTENING→끄면 OFF) + `:test` 208 그린 + 브라우저 **fleet.mjs 37**(API usedBy·페이지 구성(탭/카드/그래프/셀렉트 없음)·포트 스트립 HTTP/LISTENING/꺼짐 토글→OFF 점선·그룹 mine 펼침/남의 것 접힘·관리자·+ Mock·접힘 지속·행 LED 펄스/포트/경로/라우트 필/↗1/무매칭/vN·TCP 행·꺼진 행·⏻⋯ 항상 표시·검색=행 숨김+헤더 N/M·현황 필터·⏻ 끄기→리스너 닫힘→켜기·⋯ 이름/즐겨찾기/★ 필터/워크플로 펼침·선택 모드 일괄 끄기/켜기·Ctrl+클릭·그룹 + Mock→대상 워크스페이스·포트 칩→행 플래시·행 클릭/Enter→편집기·콘솔 무에러) + product 24·split 45·ui 18·ctxpath 24 무회귀(노드/호버/dim 단언을 행/숨김으로 치환). 가이드 [10장](docs/guide/10-Mock-서버.md) "서버 인벤토리" 절 재작성(스크린샷 교체).
- ⚠ mine 은 멤버십 기준이라 관리자도 소속 아닌 팀은 남의 그룹에("관리자" 배지, 편집은 가능). 다른 사용자 개인 워크스페이스 이름("개인 — {user}")이 포트 점유자로 보일 수 있음(사내 도구 전제). HTTP 게이트웨이 포트는 서버가 실제 바인딩한 포트(프록시 뒤에서는 브라우저 주소와 다를 수 있음 — 행/포트 스트립의 base URL 은 브라우저 오리진 기준). usedBy 는 30초 인덱스 캐시(새 워크플로 반영 지연). 그룹 접힘·즐겨찾기는 브라우저 localStorage. 이전 세션 문서(2026-09-09 "Mock 목록 대시보드화"·"HTTP/TCP 완전 분리 목록") 의 목록·탭·카드 서술은 **이 변경으로 대체**(편집기 부분은 유효).

### Mock 어시스턴트: TCP Mock 에도 ✨ AI · max-tokens 16384 · Copilot 출력 한도 클램프 (같은 날)
- **TCP 편집기에 ✨ AI 버튼**([MockServerEditor](frontend/src/routes/MockServerEditor.tsx) — 이전엔 `isHttp &&` 로 HTTP 만). [MockAssistantService.buildSystemPrompt](backend/src/main/kotlin/com/flowlink/assistant/MockAssistantService.kt) 가 현재 spec 을 보고 **"THIS MOCK IS TCP-ONLY"**(routes 빈 배열 유지·tcp 섹션만·포트/필드·규칙 id 유지) 또는 **"HTTP-ONLY"**(tcp null 유지) 힌트를 붙인다.
- `flowlink.assistant.max-tokens` yml 기본 4096 → **16384**(`FLOWLINK_ASSISTANT_MAX_TOKENS`, 코드 기본과 일치). Copilot 은 모델별 `max_output_tokens` 를 넘는 `max_tokens` 에 400 을 주므로 [AssistantOAuthService.outputLimit](backend/src/main/kotlin/com/flowlink/assistant/AssistantOAuthService.kt)(`/models` 응답을 10분 캐시, `limits.max_output_tokens`)로 [AssistantService.callLlmText](backend/src/main/kotlin/com/flowlink/assistant/AssistantService.kt) 가 **자동 클램프**(Anthropic 키 경로는 그대로)(2026-09-14 제거됨). 운영가이드 §7 표 갱신.

## 최근 변경 (2026-09-14) — OIDC(issuer-uri) 리소스 서버 모드 제거 (`refactor/trim-config`)
- [SecurityConfig](backend/src/main/kotlin/com/flowlink/security/SecurityConfig.kt) **2분기**(GitHub 게스트 모드 / dev permitAll) — `issuer-uri` 기반 OIDC RBAC 분기·`PUBLIC_PATHS`·issuer-uri WARN 삭제. `GET /auth/config` 는 `mode=github|none` 만 반환. 프론트 [AuthContext](frontend/src/auth/AuthContext.tsx) 의 oidc 안내 화면(`blockedOidc`) 삭제. presence 인터셉터의 `guestAllowed` 파라미터 제거(decoder 있음 = github 모드 = 무토큰은 게스트). `application.yml` 의 issuer-uri 대안 주석 삭제.
- 유지: JwtRoleConverter·TenantClaimFilter·`flowlink.security.tenant-claim`·`spring-boot-starter-oauth2-resource-server` — GitHub 모드의 자체 JWT 검증이 그대로 사용.
- ⚠ `spring.security.oauth2.resourceserver.jwt.issuer-uri` 를 주면 Boot 자동설정이 JwtDecoder 빈을 만들지만 SecurityConfig 는 이를 무시(github-enabled 아니면 dev permitAll) — 경고 없이 조용히 개방되므로 운영 env 에서 제거할 것.

## 최근 변경 (2026-09-14) — allowed-logins / admin-logins 제거 + 최초 사용자 관리자 부트스트랩 (`refactor/trim-config`)
- env 화이트리스트/관리자 목록(`FLOWLINK_AUTH_ALLOWED_LOGINS`/`ADMIN_LOGINS`, `AuthProperties.allows/isBootstrapAdmin`) 삭제. **테넌트에 ADMIN 이 없으면 처음 등록되는 사용자가 ADMIN+APPROVED**([WorkspaceService.touchUser](backend/src/main/kotlin/com/flowlink/workspace/WorkspaceService.kt) 단일 등록 경로 — GithubAuthService.complete 도 이걸 호출, `existsByTenantIdAndGlobalRole` 1개 추가, INFO 로그, 동시 첫 로그인 레이스 무시). 신규 사용자는 전부 PENDING, dev 는 항상 관리자(부트스트랩 대상 아님 — 로컬 dev H2 를 github 모드로 켜도 dev 행이 ADMIN 을 선점하지 않게). putMember/putUser 사전 등록 경로는 부트스트랩 대상 아님(초대받은 사람이 관리자가 되는 사고 방지).
- ⚠ 기존 운영 DB 에 globalRole=ADMIN 행이 없으면(관리자가 env 로만 지정돼 있었다면) **배포 후 처음 로그인하는 신규 사용자**가 ADMIN 이 된다 — 배포 전에 `UPDATE flowlink_app_user SET global_role='ADMIN' WHERE username='<운영자>'` 로 지정할 것.
- 검증: GithubAuthStartupValidatorTest 3종 + WorkspaceRbacTest 부트스트랩 케이스 + 전체 스위트.

## 최근 변경 (2026-09-14) — SSRF 가드 제거 (`refactor/trim-config`)
- `SsrfGuard`·`SsrfBlockedException`·`SsrfGuardTest`·`ExecutionProperties.Ssrf`·yml `flowlink.execution.ssrf.*` 삭제. HTTP/TCP 노드(서버 모드)·Mock 콜백·어시스턴트(Anthropic/Copilot)·GitHub 로그인의 아웃바운드는 **무검사** — 사설망·클라우드 메타데이터·loopback 자유 호출. 스킴 allowlist(http/https)도 함께 사라짐(비 http/https URL 은 RestClient/HttpClient 가 실패시킴 → 노드 실패 `⚠ 요청 실패: …`). h2 프로파일(2026-09-14 `local` 로 개명)은 이미 `enabled: false` 였으므로 로컬 동작 동일. **사내망 배포 전제.** NotificationService 의 자체 스킴 검증은 유지.

## 최근 변경 (2026-09-14) — Vault KV 제거(Transit/AppRole 만 유지) (`refactor/trim-config`)
- 삭제: `VaultSecretSource`(KV v2 클라이언트·TTL 캐시), [SecretService](backend/src/main/kotlin/com/flowlink/secret/SecretService.kt) 의 Vault 오버레이(listNames/activeSecrets)·`SecretView.source`(프론트 SecretsDialog `Vault` 배지/읽기전용 그룹 포함), [AppJwt](backend/src/main/kotlin/com/flowlink/security/AppJwt.kt) 의 Vault `jwt-secret` 조회, `VaultProperties` enabled/mount/path/config-path/refresh-seconds, env `FLOWLINK_VAULT_ENABLED`/`MOUNT`/`PATH`/`CONFIG_PATH`/`REFRESH_SECONDS`.
- 유지: `VaultTokenSource`(정적 토큰+AppRole)·`TransitCrypto`·`RoutingCrypto`·`CryptoConfig`·재암호화 이관. **스위치는 `flowlink.vault.transit.enabled` 하나.**
- ⚠ github 모드 jwt-secret 은 env `FLOWLINK_AUTH_JWT_SECRET` **필수** — Vault KV 에만 두던 배포는 기동 실패(fail-closed). AppRole 정책도 `transit/encrypt|decrypt/flowlink` 2경로면 충분.

## 최근 변경 (2026-09-14) — 프로파일 정리: local(H2 파일, 기본) / dev(Oracle) (`refactor/trim-config`)
- `application-h2.yml` → [application-local.yml](backend/src/main/resources/application-local.yml)(이름만), Oracle datasource(url/user/password)·flyway 블록을 `application.yml` 에서 새 [application-dev.yml](backend/src/main/resources/application-dev.yml) 로 분리. `application.yml` 은 공통 + `spring.profiles.default: local`(프로파일 미지정 = local). `scripts/start.*` 기본도 `local`. Kotlin 코드에 프로파일 문자열 판정은 없어 코드 변경 0.
- ⚠ 기존 `SPRING_PROFILES_ACTIVE=oracle`(구 scripts 기본 `h2` 도 동일)은 **무효** — 그 이름의 프로파일 파일이 없어 Boot 가 내장 인메모리 H2 를 자동 구성하고, flyway-core 가 classpath 에 있어 Flyway 기본 위치(`classpath:db/migration` 재귀)의 Oracle `V1__init.sql` 을 H2 에 실행하다 `Migration V1__init.sql failed` 로 **기동 실패**한다(fail-fast — 조용히 빈 DB 로 뜨지 않음). 배포 env 를 `dev`(Oracle)/`local`(H2) 로 바꿀 것.
- `hibernate.type.preferred_uuid_jdbc_type: CHAR` 는 공통 `application.yml` 에 남김 — 구 h2 프로파일도 base 를 상속해 CHAR 였으므로 기존 `.mv.db` 의 uuid 컬럼(CHAR(36))과 호환. dev 로 옮기면 local 의 uuid 매핑이 바뀌어 기존 파일 DB 와 충돌한다.

## 최근 변경 (2026-09-14) — relay base-url env / state-secret 제거 (`refactor/trim-config`)
- 삭제: `ExecutionProperties.Relay`·`stateSecret`(생성자는 `(http, maxNodesPerRun, worker)`), `application.yml` 의 `execution.relay` 블록, [StateCrypto](backend/src/main/kotlin/com/flowlink/execution/engine/StateCrypto.kt) 생성자 인자·`isDevKey`(인자 없는 `StateCrypto()` 하나), [CryptoConfig](backend/src/main/kotlin/com/flowlink/common/crypto/CryptoConfig.kt) 의 `ExecutionProperties` 주입(Transit 미사용이면 무조건 WARN 한 줄 "Transit 미사용 — 고정키로 로컬 암호화(사내망 전제)"), [RelayBaseResolver](backend/src/main/kotlin/com/flowlink/settings/RelayBaseResolver.kt) 의 env 단계(화면 설정 → 접속 오리진 → `http://localhost:18080`), StateCryptoTest 의 wrongKeyFails/devKeyFlag(테스트 189→187).
- 유지: `StateCrypto.DEV_SECRET` 값 그대로 → env 미설정(dev 키)으로 쓰던 로컬 DB 는 그대로 열린다.
- ⚠ `FLOWLINK_EXECUTION_STATE_SECRET` 을 설정해 운영하던 DB 는 시크릿·대기 스냅샷·Copilot 토큰 **전부 복호화 불가**(AEADBadTagException — Transit 모드의 레거시 폴백도 고정키). 배포 전 구 버전에서 Transit 전환 기동으로 재암호화 이관을 끝내거나 시크릿 재입력.
- ⚠ 남아 있는 `FLOWLINK_EXECUTION_RELAY_BASEURL` env 는 조용히 무시된다(relaxed binding·unknown field) — 스케줄/웹훅 실행(요청 컨텍스트 없음)의 콜백 base 가 localhost 로 떨어지므로 ⚙ 설정에 저장할 것.

## 참고 문서
- `backend/README.md` — 백엔드 구조·설정·API 요약 · `frontend/README.md` · `infra/README.md`(배포)
- **`docs/guide/`** — 실사용자 가이드(심플+심화 15챕터, 스크린샷) · `docs/사용가이드.md` — 한 페이지 요약본
- **`docs/운영가이드.md`** — 운영자 가이드(yml/env 전체 설정 레퍼런스·인증 모드·암호화 키·체크리스트)
- `docs/superpowers/` — 구현 계획/설계 스펙
