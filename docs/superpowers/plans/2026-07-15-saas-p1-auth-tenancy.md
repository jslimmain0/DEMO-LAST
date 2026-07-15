# SaaS P1 — 인증·RBAC·테넌시 하드닝 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keycloak OIDC 로그인 + admin/editor/viewer/platform-admin RBAC + 팀 격리 하드닝(mock slug 팀 스코프, 테넌트 구멍 수정), dev 모드(permitAll) 완전 무회귀.

**Architecture:** 기존 `ObjectProvider<JwtDecoder>` 모드 스위치 유지. OIDC 분기에만 롤 컨버터+URL RBAC 추가. 프론트는 `/api/v1/auth/config`(public)로 인증 모드를 발견(env 불필요)하고 oidc-client-ts PKCE로 로그인, `/api/v1/me`로 UI 게이팅.

**Tech Stack:** Spring Security resource server(기존), oidc-client-ts, Keycloak 26(Docker, realm import).

## Global Constraints

- dev 모드(issuer-uri 미설정) = 현행과 100% 동일 동작(permitAll, default 테넌트, 데모/seed 무변경).
- Jackson 역직렬화 대상 DTO에 `@get:JvmName` 금지 (CLAUDE.md).
- 프론트 새 코드는 string union(enum 금지, `erasableSyntaxOnly`), 클래스 접두 `fl-`, CSS 변수 `--fl-*`, UI 텍스트 한국어.
- 테스트 실행: `$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; ./gradlew test` (backend/), `npm run build && npm run lint` (frontend/).
- `/relay/**`, `/mock/**` 는 계속 permitAll.

---

### Task 1: JwtRoleConverter (Keycloak 롤 → ROLE_* 권한) — TDD

**Files:**
- Create: `backend/src/main/kotlin/com/flowlink/security/JwtRoleConverter.kt`
- Test: `backend/src/test/kotlin/com/flowlink/security/JwtRoleConverterTest.kt`

**Interfaces:**
- Produces: `class JwtRoleConverter : Converter<Jwt, AbstractAuthenticationToken>` — `realm_access.roles[]` + `resource_access.*.roles[]` → `SimpleGrantedAuthority("ROLE_"+r)`; 결과 토큰은 `JwtAuthenticationToken`(name=preferred_username ?: sub).

- [ ] 테스트: realm 롤만 / resource 롤만 / 둘 다(중복 dedupe) / 클레임 없음(빈 권한) / name 규칙(preferred_username 우선, 없으면 sub). Jwt는 `Jwt.withTokenValue("t").header("alg","none").claim(...)` 빌더로 생성.
- [ ] 구현(핵심):
```kotlin
class JwtRoleConverter : Converter<Jwt, AbstractAuthenticationToken> {
    override fun convert(jwt: Jwt): AbstractAuthenticationToken {
        val roles = LinkedHashSet<String>()
        (jwt.getClaimAsMap("realm_access")?.get("roles") as? Collection<*>)?.forEach { it?.let { r -> roles.add(r.toString()) } }
        (jwt.getClaimAsMap("resource_access"))?.values?.forEach { v ->
            ((v as? Map<*, *>)?.get("roles") as? Collection<*>)?.forEach { it?.let { r -> roles.add(r.toString()) } }
        }
        val auth = roles.map { SimpleGrantedAuthority("ROLE_$it") }
        val name = jwt.getClaimAsString("preferred_username") ?: jwt.subject
        return JwtAuthenticationToken(jwt, auth, name)
    }
}
```
- [ ] `./gradlew test` PASS → commit `feat(security): Keycloak 롤 → ROLE_* 권한 컨버터`

### Task 2: SecurityConfig RBAC + SecurityProperties 확장 + CORS 프로퍼티화

**Files:**
- Modify: `backend/src/main/kotlin/com/flowlink/security/SecurityProperties.kt` (+`clientId`(기본 `flowlink-web`), `corsOrigins: List<String>`(기본 = 현행 3개 localhost))
- Modify: `backend/src/main/kotlin/com/flowlink/security/SecurityConfig.kt`
- Modify: `backend/src/main/resources/application.yml` (`flowlink.security.client-id`, `cors-origins` 주석 샘플)

**Interfaces:**
- Produces: OIDC 분기 authorize 규칙(§스펙 1.2). PUBLIC_PATHS에 `/api/v1/auth/config` 추가.

- [ ] OIDC 분기 규칙(순서 중요 — 구체 경로 먼저):
```kotlin
auth
  .requestMatchers(*PUBLIC_PATHS).permitAll()
  .requestMatchers("/api/v1/auth/config").permitAll()
  .requestMatchers(HttpMethod.GET, "/api/v1/**").authenticated()
  .requestMatchers("/api/v1/plugins/**").hasRole("platform-admin")
  .requestMatchers(HttpMethod.PUT, "/api/v1/settings/**").hasRole("admin")
  .requestMatchers("/api/v1/**").hasAnyRole("editor", "admin")   // 나머지 쓰기 전부
  .anyRequest().authenticated()
```
  `oauth2ResourceServer { jwt { it.jwtAuthenticationConverter(JwtRoleConverter()) } }`. run/resume는 POST라 editor 규칙에 자동 포함.
- [ ] CORS: `config.allowedOrigins = props.corsOrigins`.
- [ ] dev 분기 무변경 확인. `./gradlew test` + `bootRun -H2` 기동 스모크 → commit

### Task 3: AuthController(/auth/config·/me) + triggeredBy + listForFlow 테넌트 수정

**Files:**
- Create: `backend/src/main/kotlin/com/flowlink/security/AuthController.kt`
- Modify: `backend/src/main/kotlin/com/flowlink/execution/ExecutionService.kt` (`currentUser()`, `listForFlow`)

**Interfaces:**
- Produces: `GET /api/v1/auth/config` → `AuthConfigResponse(enabled: Boolean, issuer: String?, clientId: String)` (public). `GET /api/v1/me` → `MeResponse(username: String, tenant: String, roles: List<String>)` (인증, dev 모드에선 `{"dev", "default", ["admin","editor","platform-admin"]}` 반환 — 프론트 게이팅 단일 경로).

- [ ] AuthController: issuer = `@Value("\${spring.security.oauth2.resourceserver.jwt.issuer-uri:}")`; enabled = issuer.isNotBlank(). `/me`: `SecurityContextHolder` auth가 `JwtAuthenticationToken`이면 name/authorities(ROLE_ 제거)/TenantContext, 아니면 dev 응답.
- [ ] `currentUser()`: JwtAuthenticationToken.name 반환(dev null 유지).
- [ ] `listForFlow`: `flowRepo.findByIdAndTenantId(flowId, tenant) ?: throw NotFound` 선행.
- [ ] 기동 스모크(dev): `/api/v1/auth/config` → `{enabled:false}`, `/api/v1/me` → dev 응답. commit

### Task 4: mock slug 팀 스코프 (+게이트웨이 2세그먼트 파싱) — TDD

**Files:**
- Create: `backend/src/main/resources/db/migration/V7__mock_slug_per_tenant.sql`
- Modify: `backend/src/main/kotlin/com/flowlink/core/domain/MockServer.kt` (@Column unique 제거 → @Table uniqueConstraints(tenant_id,slug))
- Modify: `backend/src/main/kotlin/com/flowlink/core/repository/MockServerRepository.kt` (+`findByTenantIdAndSlug`, `existsByTenantIdAndSlug`)
- Modify: `backend/src/main/kotlin/com/flowlink/mock/MockServerService.kt` (create 중복검사 per-tenant, +`findForServing(tenant, slug)`)
- Modify: `backend/src/main/kotlin/com/flowlink/mock/MockGatewayController.kt` (파싱 규칙)
- Test: `backend/src/test/kotlin/com/flowlink/mock/MockPathParseTest.kt`

**Interfaces:**
- Produces: 게이트웨이 해석 규칙(순수 함수로 분리해 테스트): `/mock/{a}/{b}/rest…` → ① (tenant=a, slug=b) 조회 성공 시 rawPath=`/rest…` ② 실패 시 레거시 (slug=a) rawPath=`/{b}/rest…`. `/mock/{a}`·`/mock/{a}/…`의 기존 레거시 동작 유지. `__routes` 예약 경로 양쪽 모두 동작.

- [ ] V7: `DROP INDEX ux_mock_server_slug; ALTER TABLE mock_server ADD CONSTRAINT uq_mock_server_tenant_slug UNIQUE (tenant_id, slug);`
- [ ] 파싱을 lookup 콜백 받는 순수 함수로 작성 + 단위테스트(2세그먼트 매치/레거시 폴백/1세그먼트/`__routes`/루트 경로).
- [ ] H2 dev 주의사항(기존 파일 DB의 옛 유니크 인덱스 잔존) CLAUDE.md에 문서화는 P1 마지막 태스크에서.
- [ ] `./gradlew test` + seed-mock.mjs 무회귀(레거시 경로) → commit

### Task 5: 프론트 인증 기반 (oidc-client-ts + AuthContext + 인터셉터 + /me)

**Files:**
- Modify: `frontend/package.json` (+`oidc-client-ts`)
- Create: `frontend/src/auth/auth.ts` (UserManager 초기화·토큰 접근·모듈 싱글턴)
- Create: `frontend/src/auth/AuthContext.tsx` (Provider + `useAuth()` + `usePermissions()`)
- Create: `frontend/src/auth/AuthCallback.tsx` (`/auth/callback` 라우트, StrictMode 이중실행 가드)
- Modify: `frontend/src/api/client.ts` (인터셉터 — `http`·`uploadHttp` 둘 다, `authApi` 추가)
- Modify: `frontend/src/App.tsx` (Provider 래핑 + `/auth/callback` 라우트)

**Interfaces:**
- Produces: `useAuth(): {ready, enabled, me: {username,tenant,roles}|null, logout()}` / `usePermissions(): {canEdit, canAdmin, isViewer}` (dev 모드: canEdit=true). `getAccessToken(): string|null`. 부팅: config fetch → enabled면 getUser()→없으면 signinRedirect(전면 SSO) → /me 로드 → ready.
- 인터셉터: 요청에 Bearer, 401 응답 → `signinSilent()` 1회 재시도 → 실패 시 `signinRedirect()`.

- [ ] 구현 → `npm run build && npm run lint` 통과 → dev 모드 브라우저 스모크(로그인 없음 그대로) → commit

### Task 6: 토스트 시스템 + 저장 409 다이얼로그 + 에러 표면화

**Files:**
- Create: `frontend/src/components/toast.tsx` (`toast(msg, kind?: 'info'|'error'|'ok')` 모듈 함수 + `<Toasts/>`)
- Modify: `frontend/src/App.tsx` (<Toasts/> 마운트)
- Modify: `frontend/src/routes/Editor.tsx` (save onError→409 다이얼로그/기타 토스트, onRun catch{} 제거→토스트)
- Create: `frontend/src/components/ConflictDialog.tsx` ([서버 최신 불러오기]=flow refetch+loadGraph / [다시 저장]=save.mutate() 재시도)

- [ ] 구현 → build/lint → 수동: 두 탭 저장 충돌 재현으로 409 다이얼로그 확인 → commit

### Task 7: viewer 읽기 전용 게이팅 + 사용자 칩

**Files:**
- Modify: `frontend/src/app/AppShell.tsx` (사이드바 하단 사용자 칩: 이름·팀·역할 배지·로그아웃 — enabled=false면 미표시)
- Modify: `frontend/src/routes/Editor.tsx` (viewer: 저장/실행/API/가져오기 disable + "읽기 전용" 배지, Ctrl+S·자동저장 가드)
- Modify: `frontend/src/routes/Dashboard.tsx` (viewer: 새 워크플로/새 폴더/카드 ⋯ 쓰기 항목/드래그 비활성)
- Modify: `frontend/src/routes/MockServers.tsx`·`MockServerEditor.tsx` (viewer: 생성/토글/삭제/저장 비활성)
- Modify: `frontend/src/routes/Dashboard.tsx` 플러그인 업로드 UI(있는 위치 확인) — canAdmin(platform-admin) 게이트

- [ ] 구현 → build/lint → commit

### Task 8: mock base URL 테넌트 표시 (프론트)

**Files:**
- Modify: `frontend/src/api/client.ts` (`mockBaseUrl(slug, tenant?)` — tenant 있고 ≠'default'면 `/mock/{tenant}/{slug}`)
- Modify: `frontend/src/routes/MockServers.tsx`·`MockServerEditor.tsx` (복사 문자열·안내 패턴)

- [ ] 구현 → build/lint → commit

### Task 9: Keycloak realm + dev compose + OIDC e2e

**Files:**
- Create: `deploy/keycloak/flowlink-realm.json` (realm `flowlink`, client `flowlink-web` public PKCE(+direct access grants — e2e용), 롤 4종, user attribute `tenant` 매퍼, 유저 alice/bob/carol(team-a, admin+platform-admin/editor/viewer)·dave(team-b editor), 비번 = 아이디와 동일)
- Create: `deploy/keycloak-dev.compose.yml` (Keycloak 26, 8081→8080, `--import-realm`)
- Create: `scripts/e2e-saas-p1.mjs` (리포 루트 scripts/ 없으면 demos/ 옆 `e2e/` 디렉토리)

**Interfaces:**
- e2e 시나리오: Keycloak 기동 → 백엔드를 `SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI=http://localhost:8081/realms/flowlink` + H2로 기동 → password grant로 alice/bob/carol/dave 토큰 → ①무토큰 401 ②carol(viewer) GET 200/POST 403 ③bob 플로우 CRUD+실행 200 ④dave가 bob 플로우 GET 404(테넌트 격리) ⑤`GET /flows/{bobFlow}/runs`를 dave 토큰으로 → 404(구멍 수정 확인) ⑥bob 플러그인 업로드 403, alice 200(또는 유효 JAR 400) ⑦mock slug: bob과 dave가 같은 slug 생성 성공, 각자 `/mock/{tenant}/{slug}` 서빙 + 레거시 경로 default 테넌트 폴백 ⑧/me 응답 확인.

- [ ] realm JSON·compose 작성 → `docker compose -f deploy/keycloak-dev.compose.yml up -d` → e2e 스크립트 작성·실행 전부 PASS
- [ ] 브라우저 확인: :5173(또는 jar) 접속 → Keycloak 로그인 리다이렉트 → carol로 읽기전용 UI, bob으로 편집 가능
- [ ] dev 모드 무회귀: issuer 없이 재기동 → 데모 seed + 기존 흐름 정상
- [ ] commit `feat(saas-p1): Keycloak realm/컴포즈 + OIDC e2e`

### Task 10: 문서화 마무리

**Files:**
- Modify: `CLAUDE.md` (P1 변경 요약: 인증 모드/역할/mock slug 규칙/H2 dev 유니크 인덱스 주의)
- Modify: `deploy/README.md` (Keycloak dev 컴포즈 사용법)

- [ ] 작성 → commit

## Self-Review 결과
- 스펙 §1(1.1~1.3)→T1-3, §2→T5-7, §3 mock→T4·T8, 플러그인 게이트→T2·T7, §7 P1 검증→T9. 커버리지 OK.
- TCP mock 프로퍼티(스펙 §3)는 P4(운영 설정)와 함께가 자연스러워 P4로 이월 — 스펙 위반 아님(정책 유지가 기본).
