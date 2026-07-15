# FlowLink SaaS 전환(사내 공유 서비스) — 설계

날짜: 2026-07-15 · 브랜치: `saas-overhaul`

## 0. 목적/범위

여러 팀이 쓰는 **사내 중앙 인스턴스(사내 공유 SaaS)** 로 갈아엎는다. 상용 SaaS(가입/과금)는 범위 밖.

| 결정 | 내용 |
|---|---|
| 인증 | **Keycloak 직접 운영**(Docker) — 기존 OIDC 리소스 서버 골격에 issuer-uri 연결. IdP 비종속 유지 |
| 권한 | 팀(테넌트) 완전 격리 + 팀 내 3역할 **admin / editor / viewer** + 전역 **platform-admin**(플러그인) |
| 실행 엔진 | **비동기화**(POST 즉시 반환, 전용 풀 실행) + **재개 상태 DB 내구화**(재시작/배포 생존) |
| DB | **Oracle**(개발/데모 = Docker `gvenzl/oracle-free` 23ai, 운영 = 사내 Oracle에 JDBC URL 교체). H2 dev 모드 유지 |
| 부가 | **실시간 presence**(커서·이름표·선택/편집 중 표시·저장 알림). 공동편집(CRDT)은 범위 밖 |
| 배포 | **Docker Compose**(app + Oracle + Keycloak, realm 자동 import) + Dockerfile |

무회귀 원칙: **issuer-uri 미설정(dev 모드)이면 지금과 동일하게 동작**(permitAll·default 테넌트·H2·데모 스크립트 전부 무변경 동작).

## 1. 인증·RBAC (백엔드)

### 1.1 역할 매핑
- Keycloak realm 롤 `admin`/`editor`/`viewer`/`platform-admin` → 커스텀 `JwtAuthenticationConverter`가
  `realm_access.roles`(+`resource_access.{client}.roles`)를 `ROLE_*` 권한으로 매핑. OIDC 분기 안에서만 배선(dev 모드 무변화).
- 테넌트: 기존 `flowlink.security.tenant-claim`(기본 `tenant`) 클레임 → Keycloak 사용자 attribute `tenant` + protocol mapper.

### 1.2 URL RBAC (SecurityConfig OIDC 분기, 메서드 시큐리티 미도입)
| 경로 | 규칙 |
|---|---|
| `GET /api/v1/**` | 인증만(viewer 포함) |
| `POST/PUT/PATCH/DELETE /api/v1/**` | `editor` 또는 `admin` |
| `/api/v1/plugins/**` 쓰기 | `platform-admin` (전역 레지스트리 — 임의 JAR 실행이라 팀 admin에게도 미개방) |
| `/api/v1/settings/**` 쓰기 | `admin` |
| `POST /flows/{id}/runs`, `POST /executions/{id}/resume` | `editor`+ (viewer 실행 불가) |
| `/relay/**`, `/mock/**`, actuator/health, swagger | 기존대로 permitAll (외부 시스템 호출 경로) |

### 1.3 부수 수정 (브리프에서 발견)
- **테넌트 구멍 수정**: `ExecutionService.listForFlow`가 tenant 미필터(`GET /flows/{id}/runs` 교차 테넌트 노출) → 테넌트 스코프 flow 소유 확인 선행.
- `currentUser()` TODO 해소: JWT `preferred_username`(없으면 sub) → `Execution.triggeredBy`.
- CORS 오리진 하드코딩 → `flowlink.security.cors-origins` 프로퍼티(기본값 = 현행 localhost 목록).
- `GET /api/v1/auth/config`(public) 신설: `{enabled, issuer, clientId}` — 프론트가 env 없이 인증 모드 발견.
- `GET /api/v1/me`(인증): `{username, tenant, roles}` — 프론트 UI 게이팅 소스.

## 2. 프론트 로그인·권한 UI

- **oidc-client-ts**(IdP 비종속) + 수제 AuthProvider. 부팅 시 `/auth/config` 조회 → `enabled=false`면 지금과 동일(로그인 없음).
  enabled면 Authorization Code + PKCE, `/auth/callback` 라우트(StrictMode 이중 실행 가드), refresh token 자동 갱신.
- axios 인터셉터(두 인스턴스 모두): Bearer 부착, 401 → silent refresh → 실패 시 로그인 리다이렉트. `dirty` 중 리다이렉트는 beforeunload 경고와 충돌 → 리다이렉트 전 확인.
- **미니 토스트 시스템 신설**(알려진 부채): 401/403/409/실행 에러 표면화. `onRun`의 무음 `catch {}` 제거.
- **저장 409 다이얼로그**: 낙관적 락 충돌 시 "다른 사용자가 먼저 저장" — [서버 최신 버전 불러오기] / [내 변경을 새 버전으로 다시 저장](버전은 append-only라 둘 다 안전).
- **viewer 읽기 전용**: `/me` 기반 `usePermissions()` — 저장/실행/Ctrl+S/자동저장, Dashboard·MockServers·플러그인의 쓰기 버튼 비활성+읽기전용 배지. 서버 403이 최종 권위(UI는 편의).
- 사이드바 하단(AppShell) 사용자 칩(이름·팀·역할·로그아웃). Editor 헤더는 별도(AppShell 미사용)라 실행/저장 버튼 게이팅으로 처리.

## 3. 테넌시 하드닝 (mock/플러그인)

- **mock slug 팀 스코프**: 유니크를 `(tenant_id, slug)`로 변경. 서빙 경로 `/mock/{tenant}/{slug}/**` 지원하되
  **하위호환 파싱**: 첫 두 세그먼트가 (tenant, slug) 매치면 그걸로, 아니면 레거시 전역 slug(첫 세그먼트) — 기존
  `default` 테넌트 데이터·demos·seed 스크립트 무변경 동작. 프론트 base URL 표시는 `me.tenant !== 'default'`일 때만 tenant 세그먼트 포함.
  게이트웨이의 수동 prefix 파싱(`"/mock/$slug"` substring)도 함께 수정.
- **TCP mock**: 정책 유지(전역 first-come, 충돌 400). `flowlink.mock.tcp.enabled`(기본 true)·포트 범위 프로퍼티만 추가(운영자가 잠글 수 있게). 사내망 전제 문서화.
- 플러그인 업로드/삭제: §1.2 platform-admin 게이트.

## 4. 내구 비동기 실행

### 4.1 데이터 모델
신규 테이블 `execution_suspension`(엔티티 + 마이그레이션):
`execution_id UUID PK · tenant_id · pending_node_id · run_state CLOB(JSON, AES-GCM 암호화) · outcome CLOB(JSON pending 명세) · wait_deadline TIMESTAMP? · updated_at`.
- `run_state` = `RunStateSnapshot`: `{activeIds, ctxValues(순서 보존 객체), ctxSeeds, index, seq, pendingNodeId, pendingFormSpec, relayBase, relayRunId}`.
  graph는 저장하지 않고 `Execution.flowVersionId`의 graphJson 재파싱으로 재구성(`FlowExecutor.rehydrate` 팩토리 신설, `ExecutionContext`에 snapshot/restore 접근자 추가).
- **시크릿 평문 이슈**(SET 시크릿이 ctx에 비마스킹): `run_state`를 AES-GCM 암호화. 키 = `flowlink.execution.state-secret`(env). 미설정 시 고정 dev 키 + OIDC 모드에서 WARN.
- **이중 재개 CAS**: 인메모리 `remove(execId, expected)` → `deleteByExecutionIdAndPendingNodeId`(영향 행수 1 = claim 승자). 콜백·타임아웃·resume 모두 이 규약.
- 숫자 타입 라운드트립(Int↔Long↔Double)은 SpEL 비교에 영향 가능 — e2e로 검증 항목에 포함.

### 4.2 실행 흐름
- `POST /flows/{id}/runs`: 요청 스레드에서 Execution 행 생성(RUNNING) + **tenant/user/relayBase 캡처**(RelayBaseResolver ③ 접속 오리진은 요청 스레드 전용 — 워커에서 부르면 localhost 오염, 반드시 선캡처) → `ThreadPoolTaskExecutor`(flowlink-exec, 기본 8, 큐 100, 초과 시 429) 제출 → **즉시 ExecutionDetail(RUNNING) 반환**.
- 워커: TenantContext set/clear(try-finally, 기존 onWaitTimeout 패턴) → drive() → 중단 시 suspension DB 저장(+인메모리 캐시) + wait면 deadline 저장·스케줄, 종료 시 정리.
- `POST /executions/{id}/resume`: claim → 결과 반영 → **연속 실행도 풀에 제출**, 즉시 현재 상태 반환.
- `recordWaitCallback`(relay): claim + ACK 산출까지만 콜백 스레드에서, **재개는 풀로**(현재는 다음 wait까지 콜백 응답이 블로킹 — 분리).
- `GET /executions/{id}`: WAITING이면 suspension의 outcome(pending 명세) 동봉 — 기존 계약 유지(프론트 폴링 대기).
- **기동 복구**: suspension 있는 WAITING → 인메모리 재수화 없이 lazy(첫 접근 시 rehydrate), wait_deadline 재무장(경과분 즉시 타임아웃). suspension 없는 RUNNING 고아 → `FAILED("서버 재시작으로 중단")` reconcile.
- 노드 단위 즉시 저장(NodeRecorder)·redaction 정책은 그대로(실행 경과 애니메이션 의존성 유지).

### 4.3 프론트 실행 루프 재구성 (Editor.onRun)
- POST가 즉시 execId를 주므로 **baseline 발견 해크 제거**(`watchRunProgress` 단순화 — detail.id 직접 폴링).
- 외부 드라이버 = `pending* || terminal`까지 GET 폴링(0.4s, WAITING 1.5s 백오프). pendingInput/Form/Client는 기존 처리 후 resume(즉시 반환) → 폴링 계속. pendingWait는 폴링 유지(백엔드 자가 재개). ⏹ = resume(aborted).
- 다른 탭 동시 실행 오탐(단일 사용자 전제) 문제도 이 구조 변경으로 자연 해소.

## 5. 실시간 presence

- 백엔드: `spring-boot-starter-websocket`, raw `TextWebSocketHandler` `/ws/presence?flowId=…`(STOMP 미사용).
  OIDC 모드 핸드셰이크 인터셉터에서 `?token=` JWT 검증 + flow 테넌트 확인, dev 모드 오픈. 서버는 **무상태 릴레이**
  (방=flowId, join 스냅샷 + broadcast). 메시지: `join/leave/cursor/selection/editing/saved`.
  SpaStaticConfig `ws/` 제외 추가, vite proxy `/ws`(ws:true) 추가.
- 프론트: `lib/presence.ts`(연결·재연결·커서 50ms 쓰로틀) + 별도 `presenceStore`(editorStore 오염 금지 — dirty/undo 불변).
  렌더링은 xyflow v12 **`ViewportPortal`**(flow 좌표에 그대로 두면 팬/줌 자동) — 원격 커서 SVG+이름표, 원격 선택은
  노드 위 색 링(로컬 `selected` 건드리지 않음). Editor 헤더에 참여자 아바타 스택. `saved` 수신 시 토스트.
  이름: OIDC면 `/me`, dev면 localStorage 닉네임 자동 생성. reduced-motion에서 무한 펄스 금지(기존 규칙 준수).

## 6. Oracle + Compose 배포

### 6.1 Oracle
- 의존성: `ojdbc11`(runtime) + `flyway-database-oracle`.
- Flyway vendor 분리: `db/migration/postgresql/`(기존 V1~V6 이동 — 체크섬 내용 기반이라 기존 PG DB 안전) +
  `db/migration/oracle/V1__init.sql`(**V1~V6+신규 테이블 통합** 풀스키마: uuid→`varchar2(36)`, text→`clob`, timestamptz→`timestamp with time zone`, boolean→`number(1)`, bigint→`number(19)`, FK cascade 재현). `spring.flyway.locations: classpath:db/migration/{vendor}`.
- `application-oracle.yml` 프로파일: oracle thin URL, `hibernate.type.preferred_uuid_jdbc_type: CHAR`(varchar2(36) 매핑),
  **`ddl-auto: none`**(엔티티 `columnDefinition="text"` 9곳이 Oracle validate와 충돌 — Flyway가 스키마 소유, validate 생략이 안전).
  SSRF `allow-loopback: true`(내장 mock 호출), capture는 기본 false 유지.
- H2/Postgres 경로 무변경.

### 6.2 Compose (`deploy/docker-compose.yml` + `deploy/Dockerfile`)
- `oracle`: `gvenzl/oracle-free:23-slim`, APP_USER=flowlink, healthcheck, volume.
- `keycloak`: `quay.io/keycloak/keycloak:26.x` `start-dev --import-realm`, realm JSON(`deploy/keycloak/flowlink-realm.json`) 마운트, 8081 노출.
  realm: client `flowlink-web`(public, PKCE S256, redirect `http://localhost:18080/*`·`:5173/*`), 롤 4종, tenant attribute mapper,
  테스트 유저 alice(team-a admin+platform-admin)/bob(team-a editor)/carol(team-a viewer)/dave(team-b editor).
- `app`: `eclipse-temurin:21-jre` + flowlink.jar. **issuer 이중 주소 문제 해법**: `issuer-uri=http://localhost:8081/realms/flowlink`
  (토큰 iss 검증용, 브라우저 관점) + `jwk-set-uri=http://keycloak:8080/…/certs`(컨테이너 내부 도달용) 분리 설정.
- `deploy/README.md` 런북 갱신. `seed-mock.mjs`에 `FLOWLINK_TOKEN` Bearer 지원(선택) 추가.

## 7. 페이즈/검증

| 페이즈 | 내용 | 검증 |
|---|---|---|
| **P1 인증·격리** | §1·2·3 | 단위(롤 컨버터·slug 파싱 규칙) + H2 dev 무회귀(기존 데모) + compose에서 로그인/403/테넌트 격리 e2e |
| **P2 내구 실행** | §4 | 단위(스냅샷 라운드트립·CAS) + H2 e2e: 비동기 폴링 실행·wait 콜백·**재시작 후 콜백 재개**·타임아웃·⏹·input/client 재개·숫자 타입 |
| **P3 presence** | §5 | 두 탭 브라우저 e2e: 커서·선택 링·저장 토스트·재접속 |
| **P4 Oracle·배포** | §6 | compose up → 마이그레이션 → 로그인 → 데모 실행 → RBAC 매트릭스(alice/bob/carol/dave) |

기존 백엔드 단위 6종 + 프론트 tsc/build/oxlint 전 페이즈 무회귀.

## 8. 범위 밖 (명시)

CRDT 공동편집 · 과금/가입 · 워커 프로세스 분리(P2의 DB 서스펜션이 발판) · 플러그인 JAR 샌드박스(권한 게이트만) ·
KMS 시크릿 볼트(상태 암호화만) · SSRF connect-time 핀닝 · X-Forwarded(프록시) 처리 · 스케줄 트리거.

## 9. 알려진 트레이드오프

- viewer의 로컬 캔버스 조작은 막지 않음(저장/실행만 차단, 서버 403 권위) — UI 전면 잠금은 비용 대비 과함.
- mock 서빙·relay는 계속 무인증(외부 시스템이 부르는 경로, 사내망 전제) — 테넌트 경로는 네임스페이스 격리이지 접근 제어가 아님.
- H2 dev DB의 기존 mock slug 전역 유니크 인덱스는 ddl-auto가 못 지움 — dev 한정, `.mv.db` 삭제로 해소(문서화).
- oracle 프로파일 `ddl-auto: none` — 스키마 드리프트는 Flyway 규율로 관리.
