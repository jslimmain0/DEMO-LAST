# FlowLink Backend (Spring Boot · Kotlin)

REST API 워크플로 오케스트레이션 플랫폼의 백엔드. **모듈러 모놀리스**(패키지 경계로 향후 워커 분리 대비).
Spring Boot 3.3.5 / Kotlin 1.9(Java 21 toolchain) / JPA + Flyway / **Oracle**(기본, 로컬 dev 는 H2 파일).
프론트(`frontend/dist`)는 `bootJar` 시 jar 에 동봉되어 **화면+API 한 프로세스(:18080)**로 서빙된다.

> 이 파일은 구조·실행·설정 요약이다. **아키텍처·기능·변경 이력의 진실원은 리포 루트 [CLAUDE.md](../CLAUDE.md)**.

## 실행

앱 lifecycle 은 리포 루트 `scripts/`(단일 jar). 백엔드만 개발 중 재실행하려면 `bootRun` 도 가능.

```bash
# 리포 루트에서 — 단일 jar(프론트 동봉), 기본 프로파일 h2(로컬 파일 DB, 인증 없음)
bash scripts/start.sh --build      # 또는 Windows: powershell -File scripts\start.ps1 -Build

# 백엔드만 (프론트 dist 없이 API 개발용)
cd backend && sh gradlew bootRun   # http://localhost:18080/swagger-ui.html
```
- **DB**: 프로파일 미지정이면 **Oracle**(base `application.yml`). **로컬 dev 는 `h2` 프로파일**(scripts 기본 — H2 파일 DB, Flyway off·`ddl-auto: update`, SSRF off). 운영 Oracle 기동은 `SPRING_PROFILES_ACTIVE=oracle`(scripts 의 h2 기본을 벗어나는 스위치 — Oracle 설정은 base 에 있음) + `FLOWLINK_DB_URL`.
- **DB override**: `FLOWLINK_DB_URL`·`FLOWLINK_DB_USER`·`FLOWLINK_DB_PASSWORD` · 포트 `FLOWLINK_PORT`.
- **H2 파일**: 기본 `~/flowlink-h2db/flowlink.mv.db`(변경 `FLOWLINK_H2_FILE`, 초기화=그 파일 삭제).

## 테스트

```bash
export JAVA_HOME="C:/Users/jslim/.jdks/corretto-21.0.10"   # PATH 에 java 없으면
sh gradlew test    # 전 단위 테스트 (DB 불필요, H2 인메모리)
```
> 한글/비ASCII 경로에서 포크 테스트 워커가 cp949 로 오디코딩하는 Gradle 이슈는 `build.gradle.kts` 의
> `-Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8` 로 회피됨. `bootJar`·`bootRun` 은 영향 없음.

## 패키지 구조 (`com.flowlink`)

```
core/        도메인·그래프·리포지토리 (Flow→FlowVersion / Execution→NodeExecution / Folder / Secret / FlowTrigger …)
definition/  플로우 CRUD·버전(불변)·import/export        execution/   실행 엔진(비동기 워커 풀)+ 실행 API
 └ engine    FlowExecutor·HttpNodeExecutor·TcpNodeExecutor·TokenResolver·ExpressionEvaluator·SsrfGuard
             ·RelayController(wait 콜백 수신·자동 재개)·StateCrypto(AES-GCM)·RunStateSnapshot(내구 재개)
folder/      폴더(중첩 트리)                              mock/        내장 Mock 서버(HTTP/TCP 게이트웨이·상태·순차응답)
security/    인증(IdP 비종속) — GitHub 로그인(자체 JWT) / OIDC 리소스서버 / dev permitAll · TenantContext · RBAC
secret/      시크릿 볼트(AES-GCM) + HashiCorp Vault 오버레이(VaultSecretSource)
settings/    런타임 설정(키-값, 콜백 base·알림 웹훅)      trigger/     자동 실행(cron 스케줄러·webhook)
assistant/   AI 어시스턴트(자연어→플로우) — Anthropic / GitHub Copilot(디바이스 플로우) / stub
presence/    실시간 협업(WebSocket 커서·편집중·그래프 릴레이)   notify/  실행 실패 알림(Slack/Teams 웹훅)
suite/       테스트 스위트 일괄 실행     transform/   변환 SPI + JAR 플러그인     common/  error·json·tenant·openapi·web(SPA)
```
Gradle 멀티모듈: 루트(앱) + `transform-spi`(변환 계약) + `plugin-sample`(참고 플러그인).

## 인증 (IdP 비종속)

`JwtDecoder` 빈 유무로 모드가 자동 결정된다:
- **GitHub 로그인**: `FLOWLINK_AUTH_GITHUB_ENABLED=true` → 디바이스 플로우 로그인 후 앱이 자체 JWT(HS256) 발급·검증([security/AppJwt](src/main/kotlin/com/flowlink/security/AppJwt.kt)). 같은 로그인이 어시스턴트 Copilot 연결로도 이어짐.
- **표준 OIDC**: `application.yml` 에 `issuer-uri` 설정 시 그 IdP(Auth0/Entra/Keycloak) 리소스 서버로 동작.
- **dev**: 둘 다 미설정이면 permitAll(로컬).

JWT 클레임(`preferred_username`·`tenant`·`realm_access.roles`) → [JwtRoleConverter](src/main/kotlin/com/flowlink/security/JwtRoleConverter.kt) `ROLE_*` + TenantClaimFilter → 쿼리 `tenant_id` 격리. (워크플로/폴더/버전은 전역 공유, 실행·mock·secret 은 사용자별.)

## 주요 설정 (`application.yml` / env)

| 블록 | env(예) | 용도 |
|---|---|---|
| `flowlink.execution.*` | `FLOWLINK_EXECUTION_STATE_SECRET`, `FLOWLINK_EXECUTION_RELAY_BASEURL` | http 타임아웃·SSRF·capture·워커 풀·suspension 암호키·콜백 base |
| `flowlink.auth.*` | `FLOWLINK_AUTH_GITHUB_ENABLED`, `FLOWLINK_AUTH_JWT_SECRET`, `FLOWLINK_AUTH_ALLOWED_LOGINS` | GitHub 로그인 |
| `flowlink.vault.*` | `FLOWLINK_VAULT_ENABLED`, `FLOWLINK_VAULT_ADDRESS`, `FLOWLINK_VAULT_TOKEN` | HashiCorp Vault 시크릿 |
| `flowlink.assistant.*` | `FLOWLINK_ASSISTANT_API_KEY`, `FLOWLINK_ASSISTANT_MODEL` | AI 어시스턴트(Anthropic 키·모델) |
| `flowlink.security.*` | `FLOWLINK_SECURITY_CORS_ORIGINS` | 테넌트 클레임·CORS |

## DB 마이그레이션

`spring.flyway.locations: classpath:db/migration/{vendor}` → **Oracle**(`oracle/` 통합 V1 + V9~V12). 기본 `ddl-auto: none` — 스키마 소유권은 Flyway.
로컬 dev 의 h2 프로파일은 Flyway off + `ddl-auto: update`(Hibernate 가 스키마 생성). (Postgres 지원은 제거 — Oracle 로 통합.)

## API 요약 (베이스 `/api/v1`)

- **정의**: `GET/POST /flows` · `GET/PATCH/DELETE /flows/{id}` · `POST/GET /flows/{id}/versions[/{no}[/restore]]` · `POST /flows/import`
- **실행**: `POST /flows/{id}/runs`(비동기, 즉시 RUNNING) · `GET /executions[/{id}]` · `POST /executions/{id}/resume|rerun` · `POST /flows/{id}/nodes/{nodeId}/run`
- **인증**: `GET /auth/config|me` · `POST /auth/github/device/start` · `GET /auth/github/device/poll`
- **기타**: `/mock-servers` · `/secrets` · `/settings` · `/flows/{id}/triggers` · `/assistant/**` · `/plugins` · `/suites/run`
- **무인증(외부)**: `/relay/**`(콜백) · `/mock/**`(Mock 서빙) · `/hooks/**`(웹훅) · `/ws/**`(presence)

Swagger UI: `/swagger-ui.html` · Health: `/actuator/health` · Prometheus: `/actuator/prometheus`.
