# 게스트 모드 구현 계획 (github 모드에서 로그인 없이 앱 사용, AI만 로그인 게이트)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `FLOWLINK_AUTH_GITHUB_ENABLED=true` 서버에서 로그인 없이 게스트로 앱 전체를 쓸 수 있고, `/api/v1/assistant/**`(AI)만 GitHub 로그인 필수가 된다.

**Architecture:** 백엔드 SecurityConfig 에 github 게스트 분기(assistant 만 `authenticated()`, 나머지 permitAll — Bearer 는 계속 인식해 로그인 사용자 신원 유지). 프론트는 github 모드 + 무토큰이면 로그인 화면 대신 게스트로 부트하고, AI 패널 자리에 로그인 게이트 카드를 띄운다(디바이스 로그인 모달). presence WS 는 게스트를 dev 방식(닉네임)으로 허용.

**Tech Stack:** Spring Security 6(resource server, HS256 AppJwt) / Kotlin / React 19 + axios / raw WebSocket.

**Spec:** [docs/superpowers/specs/2026-07-28-guest-mode-design.md](../specs/2026-07-28-guest-mode-design.md)

## Global Constraints

- UI 텍스트는 전부 한국어 (CLAUDE.md).
- github 모드면 **항상** 게스트 허용 — 새 플래그를 추가하지 않는다 (사용자 결정).
- 게스트는 **플러그인 업로드 포함 전권** — 잠기는 것은 `/api/v1/assistant/**` 뿐 (사용자 결정).
- `GithubAuthStartupValidator` 의 jwt-secret fail-closed 기동 가드는 **유지**.
- 레거시 OIDC(issuer-uri) 모드와 dev(permitAll) 모드는 **무회귀** — 기존 분기 코드 무변경.
- 백엔드 테스트 실행(작업 디렉터리 `backend/`, PowerShell):
  `$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; .\gradlew.bat test`
  (경로가 없으면 `Get-ChildItem $env:USERPROFILE\.jdks` 로 JDK21 을 찾아 대체)
- 프론트 검증(작업 디렉터리 `frontend/`): `npm run build` (tsc 포함) + `npm run lint`.
- 커밋 메시지는 리포 관례(한국어, `feat(auth): …` 형식) + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: 백엔드 — github 게스트 모드 보안 경계

**Files:**
- Test(Create): `backend/src/test/kotlin/com/flowlink/security/GuestModeSecurityTest.kt`
- Modify: `backend/src/main/kotlin/com/flowlink/security/SecurityConfig.kt`
- Modify: `backend/src/main/kotlin/com/flowlink/security/AuthController.kt` (`me()` 게스트 사용자명)
- Modify: `backend/src/main/kotlin/com/flowlink/security/AuthConfig.kt` (allowed-logins WARN 문구)

**Interfaces:**
- Consumes: `AuthProperties.githubEnabled`(기존), `AppJwt.issue(login)`(기존).
- Produces: github 모드 보안 규칙 — 게스트는 `/api/v1/assistant/**` 401, 그 외 전부 허용. `GET /api/v1/auth/me` 비인증 응답 `{"username":"guest","tenant":"default","roles":["admin","editor","platform-admin"]}` (Task 3 프론트가 의존).

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/src/test/kotlin/com/flowlink/security/GuestModeSecurityTest.kt` 생성:

```kotlin
package com.flowlink.security

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.TestPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * github 게스트 모드 보안 경계 — 앱은 로그인 없이 개방되고 /api/v1/assistant/** 만 로그인 필수.
 * (스키마: H2 인메모리 + create-drop, Flyway off — ExecutionSuspensionRepositoryTest 와 동일 관례.)
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:guestmode;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.flyway.enabled=false",
    "spring.jpa.hibernate.ddl-auto=create-drop",
    "flowlink.auth.github-enabled=true",
    "flowlink.auth.jwt-secret=guest-mode-test-secret",
])
class GuestModeSecurityTest {

    @Autowired lateinit var mvc: MockMvc
    @Autowired lateinit var appJwt: AppJwt

    @Test
    fun `게스트 - 플로우 목록 조회 허용`() {
        mvc.perform(get("/api/v1/flows")).andExpect(status().isOk)
    }

    @Test
    fun `게스트 - 플로우 생성(쓰기) 허용`() {
        mvc.perform(post("/api/v1/flows").contentType("application/json")
            .content("""{"name":"게스트 플로우"}"""))
            .andExpect(status().isCreated)
    }

    @Test
    fun `게스트 - 플러그인 목록 허용(게스트 전권 - 사용자 결정)`() {
        mvc.perform(get("/api/v1/plugins")).andExpect(status().isOk)
    }

    @Test
    fun `게스트 - assistant 는 401`() {
        mvc.perform(get("/api/v1/assistant/config")).andExpect(status().isUnauthorized)
        mvc.perform(post("/api/v1/assistant/chat").contentType("application/json").content("{}"))
            .andExpect(status().isUnauthorized)
    }

    @Test
    fun `로그인 - assistant 허용`() {
        val token = appJwt.issue("alice")
        mvc.perform(get("/api/v1/assistant/config").header("Authorization", "Bearer $token"))
            .andExpect(status().isOk)
    }

    @Test
    fun `무효 토큰 - permitAll 경로도 401`() {
        mvc.perform(get("/api/v1/flows").header("Authorization", "Bearer bogus"))
            .andExpect(status().isUnauthorized)
    }

    @Test
    fun `게스트 - auth me 는 guest 전권`() {
        mvc.perform(get("/api/v1/auth/me"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.username").value("guest"))
            .andExpect(jsonPath("$.roles[?(@=='editor')]").exists())
    }
}
```

- [ ] **Step 2: 실패 확인**

Run(작업 디렉터리 `backend/`): `$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; .\gradlew.bat test --tests "com.flowlink.security.GuestModeSecurityTest"`
Expected: FAIL — 현재 github 모드는 전체 인증 필수라 게스트 요청이 401(`게스트 - 플로우 목록`·`플로우 생성`·`플러그인`·`auth me` 실패). `로그인 - assistant`·`무효 토큰` 은 통과할 수 있음(기존 동작).
⚠ 만약 컨텍스트 부팅 자체가 실패하면(웹소켓 등) `@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)` 명시 → 그래도 실패 시 `RANDOM_PORT` + `TestRestTemplate` 로 전환한다(단, 우선 MOCK 그대로 시도).

- [ ] **Step 3: SecurityConfig 에 github 게스트 분기 추가**

`SecurityConfig.kt` — `securityFilterChain` 시그니처에 `authProps: AuthProperties` 추가하고, 기존 `if (jwtDecoder.getIfAvailable() != null)` 앞에 github 분기 삽입:

```kotlin
    @Bean
    fun securityFilterChain(http: HttpSecurity,
                            jwtDecoder: ObjectProvider<JwtDecoder>,
                            props: SecurityProperties,
                            authProps: AuthProperties): SecurityFilterChain {
```

분기 (기존 OIDC 블록·dev 블록은 **그대로** 두고 `else if`/`else` 로만 연결):

```kotlin
        if (jwtDecoder.getIfAvailable() != null && authProps.githubEnabled) {
            // github 게스트 모드(2026-07-28): 앱은 로그인 없이 개방(게스트 전권 — 사용자 결정, 사내망 전제),
            // AI(/api/v1/assistant/**)만 로그인 필수 — Copilot 이 사용자 GitHub 토큰을 쓰는 본질적 게이트.
            // Bearer 를 실은 로그인 사용자는 리소스 서버가 계속 신원 인식(triggeredBy·Copilot 연결·presence 이름).
            // 무효/만료 Bearer 는 permitAll 경로에서도 401(리소스 서버 규약) → 프론트가 토큰 폐기 후 게스트 재부트.
            http
                .authorizeHttpRequests { auth ->
                    auth
                        .requestMatchers("/api/v1/assistant/**").authenticated()
                        .anyRequest().permitAll()
                }
                .oauth2ResourceServer { oauth ->
                    oauth.jwt { jwt -> jwt.jwtAuthenticationConverter(JwtRoleConverter()) }
                }
                .addFilterAfter(TenantClaimFilter(props.tenantClaim),
                    BearerTokenAuthenticationFilter::class.java)
            log.info("보안: GitHub 게스트 모드 — 앱 개방(로그인 선택), /api/v1/assistant/** 만 로그인 필수")
        } else if (jwtDecoder.getIfAvailable() != null) {
            // (기존 OIDC 엄격 RBAC 블록 — 무변경)
```

클래스 KDoc(파일 상단 주석)에도 모드 한 줄 추가:

```kotlin
 * - **GitHub 게스트 모드(flowlink.auth.github-enabled=true)**: 앱은 로그인 없이 개방(게스트 전권),
 *   `/api/v1/assistant/**`(AI)만 로그인 필수. 로그인=AI 사용+신원 표시 게이트.
```

- [ ] **Step 4: /auth/me 게스트 사용자명**

`AuthController.kt` `me()` 의 dev 폴백을 모드별 이름으로:

```kotlin
        // 비인증: github 게스트 모드는 "guest", dev 모드는 "dev" — 양쪽 다 전권 가짜 사용자(프론트 게이팅 단일 경로)
        val fallback = if (authProps.githubEnabled) "guest" else "dev"
        return MeResponse(fallback, TenantContext.DEFAULT_TENANT, listOf("admin", "editor", "platform-admin"))
```

(기존 마지막 두 줄 `// dev 모드(permitAll): 전권 가짜 사용자` + `return MeResponse("dev", …)` 를 위 코드로 교체. `authProps` 는 이미 생성자 주입돼 있음.)

- [ ] **Step 5: allowed-logins WARN 문구 갱신**

`AuthConfig.kt` `GithubAuthStartupValidator` 의 WARN 메시지를 게스트 모드 의미로:

```kotlin
            LoggerFactory.getLogger(GithubAuthStartupValidator::class.java).warn(
                "⚠ FLOWLINK_AUTH_ALLOWED_LOGINS 미설정 — GitHub 인증한 모든 계정이 로그인할 수 있습니다" +
                    "(로그인=AI 사용·신원 표시. 앱 자체는 게스트에게 항상 개방). " +
                    "특정 계정만 허용하려면 예: FLOWLINK_AUTH_ALLOWED_LOGINS=alice,bob",
            )
```

클래스 KDoc 의 "비우면 GitHub 인증한 **누구나** 로그인/전권" 설명도 "(앱은 게스트 개방 — 로그인은 AI 게이트)" 로 한 줄 보강.

- [ ] **Step 6: 테스트 통과 확인**

Run: `$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; .\gradlew.bat test --tests "com.flowlink.security.GuestModeSecurityTest"`
Expected: PASS (7 tests)

- [ ] **Step 7: 백엔드 전체 테스트 무회귀 확인**

Run: `.\gradlew.bat test`
Expected: 전종 PASS (기존 GithubAuthStartupValidatorTest·JwtRoleConverterTest 포함)

- [ ] **Step 8: 커밋**

```bash
git add backend/src/main/kotlin/com/flowlink/security/SecurityConfig.kt backend/src/main/kotlin/com/flowlink/security/AuthController.kt backend/src/main/kotlin/com/flowlink/security/AuthConfig.kt backend/src/test/kotlin/com/flowlink/security/GuestModeSecurityTest.kt
git commit -m "feat(auth): github 게스트 모드 — 로그인 없이 앱 개방, /api/v1/assistant/** 만 로그인 필수"
```

---

### Task 2: 백엔드 — presence WS 게스트 핸드셰이크

**Files:**
- Modify: `backend/src/main/kotlin/com/flowlink/presence/PresenceHandshakeInterceptor.kt`
- Modify: `backend/src/main/kotlin/com/flowlink/presence/PresenceConfig.kt:16-27`
- Test(Modify): `backend/src/test/kotlin/com/flowlink/presence/PresenceHandshakeInterceptorTest.kt`

**Interfaces:**
- Consumes: `AuthProperties.githubEnabled`(Task 1 과 동일 프로퍼티, 코드 의존은 기존 클래스).
- Produces: `PresenceHandshakeInterceptor(decoder, tenantClaim, guestAllowed: Boolean = false, flowAccessCheck)` — guestAllowed=true 이고 쿼리에 token 이 없으면 dev 방식(쿼리 `name`)으로 허용. 기존 3-인자 호출(테스트)은 기본값으로 그대로 컴파일된다.

- [ ] **Step 1: 실패하는 테스트 추가**

`PresenceHandshakeInterceptorTest.kt` 에 테스트 3개 추가(기존 테스트 무변경):

```kotlin
    @Test
    fun `게스트 허용 - 토큰 없으면 dev 방식(쿼리 name)으로 허용`() {
        val dec = JwtDecoder { jwt("default") }
        val i = PresenceHandshakeInterceptor(dec, "tenant", guestAllowed = true) { _, _ -> true }
        val (ok, attrs, _) = run(i, "flowId=$flowId&name=%EA%B2%8C%EC%8A%A4%ED%8A%B8-ab12")
        assertTrue(ok)
        assertEquals("게스트-ab12", attrs["name"])
    }

    @Test
    fun `게스트 허용 - 무효 토큰은 여전히 401(조용한 다운그레이드 금지)`() {
        val bad = JwtDecoder { throw JwtException("bad") }
        val i = PresenceHandshakeInterceptor(bad, "tenant", guestAllowed = true) { _, _ -> true }
        val (ok, _, res) = run(i, "flowId=$flowId&token=zzz")
        assertFalse(ok)
        assertEquals(HttpStatus.UNAUTHORIZED.value(), res.status)
    }

    @Test
    fun `게스트 허용 - 유효 토큰은 JWT 사용자명 사용`() {
        val dec = JwtDecoder { jwt("default") }
        val i = PresenceHandshakeInterceptor(dec, "tenant", guestAllowed = true) { _, _ -> true }
        val (ok, attrs, _) = run(i, "flowId=$flowId&token=tok&name=ignored")
        assertTrue(ok)
        assertEquals("alice", attrs["name"])
    }
```

- [ ] **Step 2: 실패(컴파일 에러) 확인**

Run(작업 디렉터리 `backend/`): `.\gradlew.bat test --tests "com.flowlink.presence.PresenceHandshakeInterceptorTest"`
Expected: FAIL — `guestAllowed` 파라미터가 없어 컴파일 에러.

- [ ] **Step 3: 인터셉터 구현**

`PresenceHandshakeInterceptor.kt` 생성자에 `guestAllowed` 추가(람다 앞, 기본값 false):

```kotlin
class PresenceHandshakeInterceptor(
    private val decoder: JwtDecoder?,
    private val tenantClaim: String,
    private val guestAllowed: Boolean = false,
    private val flowAccessCheck: (UUID, String) -> Boolean,
) : HandshakeInterceptor {
```

`beforeHandshake` 의 `val token = params.getFirst("token") ?: return refuse(response, HttpStatus.UNAUTHORIZED)` 를 다음으로 교체:

```kotlin
        val token = params.getFirst("token")
        if (token == null && guestAllowed) {
            // github 게스트 모드 — 앱 자체가 게스트 개방이므로 WS 도 dev 방식(쿼리 name)으로 허용.
            // 토큰을 명시한 접속은 아래에서 계속 엄격 검증(무효 토큰의 조용한 게스트 다운그레이드 금지).
            attributes["flowId"] = flowId
            attributes["name"] = decoded(params.getFirst("name")).ifBlank { "게스트" }.take(40)
            return true
        }
        if (token == null) return refuse(response, HttpStatus.UNAUTHORIZED)
```

클래스 KDoc 에 모드 한 줄 추가:

```kotlin
 * - github 게스트 모드(guestAllowed=true): 토큰 없는 접속을 dev 방식(쿼리 name)으로 허용 — 앱이 게스트 개방이므로.
 *   토큰이 있으면 기존대로 검증(무효 토큰은 401 — 게스트로 조용히 다운그레이드하지 않는다).
```

- [ ] **Step 4: PresenceConfig 배선**

`PresenceConfig.kt` — 생성자에 `private val authProps: com.flowlink.security.AuthProperties` 추가(임포트 `com.flowlink.security.AuthProperties`), 인터셉터 생성에 전달:

```kotlin
        val interceptor = PresenceHandshakeInterceptor(
            decoderProvider.getIfAvailable(), props.tenantClaim, authProps.githubEnabled,
        ) { id, _ -> flowRepository.findByIdAndTenantId(id, TenantContext.SHARED_FLOW_TENANT).isPresent }
```

- [ ] **Step 5: 테스트 통과 + 전체 무회귀**

Run: `.\gradlew.bat test --tests "com.flowlink.presence.*"` → PASS (기존 5 + 신규 3)
Run: `.\gradlew.bat test` → 전종 PASS

- [ ] **Step 6: 커밋**

```bash
git add backend/src/main/kotlin/com/flowlink/presence/PresenceHandshakeInterceptor.kt backend/src/main/kotlin/com/flowlink/presence/PresenceConfig.kt backend/src/test/kotlin/com/flowlink/presence/PresenceHandshakeInterceptorTest.kt
git commit -m "feat(presence): github 게스트 모드에서 토큰 없는 WS 접속을 dev 방식으로 허용"
```

---

### Task 3: 프론트 — 게스트 부트 + 로그인 모달 + 401 가드

**Files:**
- Modify: `frontend/src/auth/AuthContext.tsx` (전면 개정 — 아래 전체 코드)
- Modify: `frontend/src/auth/GitHubLogin.tsx` (`onCancel` prop)
- Modify: `frontend/src/auth/auth.ts:53-61` (401 인터셉터 가드)

**Interfaces:**
- Consumes: Task 1 의 `GET /api/v1/auth/me` 비인증 guest 응답.
- Produces: `useAuth()` 가 `isGuest: boolean` 과 `requestLogin(): void` 를 추가로 반환(Task 4 가 사용). `GitHubLogin` 은 `onCancel?: () => void` 를 받으면 닫기 버튼을 그린다.

- [ ] **Step 1: AuthContext.tsx 개정**

파일 전체를 다음으로 교체(변경점: `needsLogin` 제거 → github 무토큰은 게스트 부트, `isGuest`/`requestLogin` 추가, 로그인 모달 렌더):

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { attachAuthInterceptors, authApi, getAccessToken, setToken, type Me } from './auth'
import { GitHubLogin } from './GitHubLogin'

interface AuthState {
  /** 부트스트랩 완료 여부 — false 동안은 화면을 그리지 않는다. */
  ready: boolean
  /** 인증 모드 여부(github|oidc). false=dev(로그인 없음). */
  enabled: boolean
  /** github 모드에서 로그인하지 않은 게스트 — 앱은 전부 쓰되 AI 만 로그인 필요. */
  isGuest: boolean
  me: Me | null
  logout: () => void
  /** 게스트가 AI 등을 위해 로그인할 때 — GitHub 디바이스 로그인 모달을 연다. */
  requestLogin: () => void
}

const AuthContext = createContext<AuthState>({
  ready: false, enabled: false, isGuest: false, me: null, logout: () => {}, requestLogin: () => {},
})

interface Boot {
  mode: string
  me: Me | null
  /** github 모드 + 토큰 없음 — 로그인 화면 대신 게스트 진입. */
  guest?: boolean
  /** OIDC 등 SPA 셀프 로그인이 없는 인증 모드인데 유효 토큰이 없음 — 로그인 화면 대신 안내. */
  blockedOidc?: boolean
}

/** github 게스트 모드에서 /me 실패 시 로컬 폴백 — 백엔드 guest 응답과 동일 구조. */
const GUEST_ME: Me = { username: 'guest', tenant: 'default', roles: ['admin', 'editor', 'platform-admin'] }

/** StrictMode 이중 이펙트에도 부트스트랩은 1회만. */
let bootPromise: Promise<Boot> | null = null

function errStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status
}

async function boot(): Promise<Boot> {
  const cfg = await authApi.config()
  if (cfg.mode === 'none') {
    // dev 모드 — 로그인 없음. /me 는 전권 가짜 사용자(게이팅 단일 경로).
    const me = await authApi.me().catch(() => null)
    return { mode: 'none', me }
  }
  // 인증 모드(github | oidc)
  attachAuthInterceptors()
  if (getAccessToken()) {
    try {
      const me = await authApi.me()
      return { mode: cfg.mode, me }
    } catch (e) {
      const status = errStatus(e)
      if (status === 401 || status === 403) {
        setToken(null) // 무효/만료 토큰만 폐기 → 아래 게스트/안내 경로로
      } else {
        // 일시 오류(5xx/네트워크)엔 유효 토큰을 버리지 않는다 — me 없이 진행(다음 새로고침에 재조회).
        return { mode: cfg.mode, me: null }
      }
    }
  }
  if (cfg.mode === 'github') {
    // 게스트 진입 — github 모드는 앱 개방(AI 만 로그인 게이트). /me 는 permitAll(guest 응답).
    const me = await authApi.me().catch(() => GUEST_ME)
    return { mode: 'github', me, guest: true }
  }
  // oidc — SPA 셀프 로그인 흐름이 없다(외부 IdP 토큰 필요). 조용히 깨지지 않게 안내 화면.
  return { mode: 'oidc', me: null, blockedOidc: true }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ ready: boolean; boot: Boot | null }>({ ready: false, boot: null })
  const [loginOpen, setLoginOpen] = useState(false)

  useEffect(() => {
    if (!bootPromise) bootPromise = boot()
    bootPromise.then((b) => setState({ ready: true, boot: b }))
  }, [])

  const logout = () => {
    setToken(null)
    if (typeof window !== 'undefined') window.location.reload()
  }

  if (!state.ready || !state.boot) {
    return <div style={centered}>로그인 확인 중…</div>
  }
  const b = state.boot
  if (b.blockedOidc) {
    return (
      <div style={centered}>
        <div style={{ maxWidth: 420, textAlign: 'center', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 800, fontSize: 20, marginBottom: 8 }}>외부 IdP 인증 필요</div>
          이 인스턴스는 OIDC(외부 IdP) 토큰 인증 모드입니다. 화면 자체 로그인은 제공되지 않습니다 —
          유효한 액세스 토큰으로 API 를 호출하거나, GitHub 로그인 모드로 전환하세요.
        </div>
      </div>
    )
  }
  return (
    <AuthContext.Provider
      value={{
        ready: true,
        enabled: b.mode !== 'none',
        isGuest: b.guest === true,
        me: b.me,
        logout,
        requestLogin: () => setLoginOpen(true),
      }}
    >
      {children}
      {loginOpen && <GitHubLogin onSuccess={() => window.location.reload()} onCancel={() => setLoginOpen(false)} />}
    </AuthContext.Provider>
  )
}

const centered = { display: 'grid', placeItems: 'center', height: '100vh', color: 'var(--fl-text-muted)', padding: 24 } as const

export function useAuth(): AuthState {
  return useContext(AuthContext)
}

/** 역할 기반 UI 게이팅 — dev/게스트 모드는 /me 가 전권이라 모두 true. */
export function usePermissions() {
  const { me } = useAuth()
  const roles = me?.roles ?? []
  const canEdit = roles.includes('editor') || roles.includes('admin')
  return {
    canEdit,
    canAdmin: roles.includes('admin'),
    canPlatformAdmin: roles.includes('platform-admin'),
    isViewer: !canEdit,
  }
}
```

- [ ] **Step 2: GitHubLogin 에 onCancel 추가**

`GitHubLogin.tsx` — 시그니처와 카드에 닫기 버튼:

```tsx
export function GitHubLogin({ onSuccess, onCancel }: { onSuccess: () => void; onCancel?: () => void }) {
```

카드 div 를 `style={{ ...card, position: 'relative' }}` 로 바꾸고 첫 자식으로:

```tsx
        {onCancel && (
          <button onClick={onCancel} aria-label="닫기" style={closeBtn}>×</button>
        )}
```

파일 하단 스타일에 추가:

```tsx
const closeBtn: CSSProperties = { position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 16 }
```

- [ ] **Step 3: 401 인터셉터 게스트 가드**

`auth.ts` 응답 인터셉터의 401 분기를 교체:

```ts
        if (status === 401 && !url.includes('/auth/')) {
          // 게스트(무토큰)의 401 은 정상(AI 게이트) — 리로드 루프를 만들지 않는다. 토큰이 있었을 때만 폐기·재부트.
          if (getAccessToken()) {
            setToken(null)
            if (typeof window !== 'undefined') window.location.reload() // 세션 만료 → 게스트/로그인 재부트
          }
        }
```

- [ ] **Step 4: 빌드 검증**

Run(작업 디렉터리 `frontend/`): `npm run build` → Expected: tsc·vite 성공
Run: `npm run lint` → Expected: 에러 0

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/auth/AuthContext.tsx frontend/src/auth/GitHubLogin.tsx frontend/src/auth/auth.ts
git commit -m "feat(auth-front): github 모드 게스트 부트 + 온디맨드 로그인 모달 + 무토큰 401 리로드 가드"
```

---

### Task 4: 프론트 — AI 로그인 게이트 + 사용자 칩 + presence 닉네임

**Files:**
- Create: `frontend/src/components/AssistantLoginGate.tsx`
- Modify: `frontend/src/routes/Editor.tsx:54` (isGuest), `:59-61` (presence 이름), `:519-525` (패널 분기)
- Modify: `frontend/src/routes/MockServerEditor.tsx:149-155` (패널 분기)
- Modify: `frontend/src/app/AppShell.tsx:20,61-72` (게스트 칩)

**Interfaces:**
- Consumes: Task 3 의 `useAuth().isGuest`·`requestLogin`.
- Produces: `AssistantLoginGate({ width?, onClose, variant? })` — variant 'editor'(도킹 패널) | 'overlay'(우측 고정, Mock 편집기).

- [ ] **Step 1: AssistantLoginGate 컴포넌트 생성**

`frontend/src/components/AssistantLoginGate.tsx`:

```tsx
import type { CSSProperties } from 'react'
import { useAuth } from '../auth/AuthContext'

/**
 * 게스트용 AI 게이트 — github 모드에서 로그인 없이 AI 패널을 열면 채팅 대신 이 카드가 뜬다.
 * 로그인하면 서버가 GitHub 토큰을 Copilot 연결로도 재사용(한 번 로그인 = 앱 + AI).
 * variant: 'editor'=에디터 우측 도킹 패널, 'overlay'=Mock 편집기 우측 고정 오버레이(MockAssistantPanel 과 동일 셸).
 */
export function AssistantLoginGate({ width, onClose, variant = 'editor' }: {
  width?: number
  onClose: () => void
  variant?: 'editor' | 'overlay'
}) {
  const { requestLogin } = useAuth()
  const shell: CSSProperties = variant === 'overlay'
    ? { position: 'fixed', top: 0, right: 0, height: '100vh', width: 340, zIndex: 60, boxShadow: 'var(--fl-shadow-lg)' }
    : { width: width ?? 360, flexShrink: 0 }
  return (
    <aside style={{ ...shell, borderLeft: '1px solid var(--fl-border)', background: 'var(--fl-surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--fl-border)' }}>
        <span aria-hidden>✨</span>
        <b style={{ flex: 1, fontSize: 13.5 }}>AI 어시스턴트</b>
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </header>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center' }}>
        <span aria-hidden style={{ fontSize: 30 }}>🔒</span>
        <b style={{ fontSize: 14 }}>GitHub 로그인이 필요합니다</b>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: 'var(--fl-text-muted)' }}>
          AI 어시스턴트는 GitHub Copilot 을 사용합니다. 로그인하면 Copilot 이 자동으로 연결되고,
          나머지 기능은 로그인 없이도 계속 쓸 수 있습니다.
        </p>
        <button onClick={requestLogin} style={loginBtn}>
          <span aria-hidden style={{ fontSize: 15 }}>🐙</span> GitHub 로 로그인
        </button>
      </div>
    </aside>
  )
}

const xBtn: CSSProperties = { width: 26, height: 26, borderRadius: 7, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const loginBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 16px', border: 'none', borderRadius: 10, background: 'var(--fl-primary)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }
```

- [ ] **Step 2: Editor.tsx 배선**

임포트 추가: `import { AssistantLoginGate } from '../components/AssistantLoginGate'`

`useAuth` 구조분해에 isGuest 추가(54행):

```tsx
  const { me, enabled: authEnabled, isGuest } = useAuth()
```

presence 이름(59-61행) — 게스트는 전원 "guest" 라 dev 닉네임 사용, 토큰도 싣지 않는다:

```tsx
    // 이름: 로그인 사용자명, 게스트/dev 는 브라우저별 닉네임(게스트 /me 는 전원 "guest" 라 devNickname 사용)
    const displayName = authEnabled && !isGuest ? (me?.username ?? devNickname()) : devNickname()
    presence.connect(id, displayName, authEnabled && !isGuest ? getAccessToken : undefined)
```

⚠ 이 useEffect 의 의존성 배열에 `isGuest` 가 없다면 추가한다(기존 `authEnabled`/`me` 와 같은 자리).

어시스턴트 패널(519-525행 부근) 분기:

```tsx
          {assistantOpen && (
            <>
              <ResizeHandle axis="x" sign={-1} size={assistantW} min={300} max={maxAssistantW} defaultSize={360} onResize={setAssistantW} onResizeEnd={(n) => saveSize('assistantW', n)} ariaLabel="어시스턴트 패널 너비 조절" />
              {isGuest
                ? <AssistantLoginGate width={assistantW} onClose={() => { setAssistantOpen(false); persistUI('fl:editor:assistant', '0') }} />
                : <AssistantPanel width={assistantW} onClose={() => { setAssistantOpen(false); persistUI('fl:editor:assistant', '0') }} />}
            </>
          )}
```

- [ ] **Step 3: MockServerEditor.tsx 배선**

임포트 추가: `import { AssistantLoginGate } from '../components/AssistantLoginGate'`
`useAuth` 구조분해에 `isGuest` 추가(29행: `const { me, isGuest } = useAuth()`).
149-155행 부근 분기:

```tsx
            {aiOpen && (isGuest
              ? <AssistantLoginGate variant="overlay" onClose={() => setAiOpen(false)} />
              : <MockAssistantPanel
                  spec={spec}
                  mockId={id}
                  onApply={(newSpec) => mutate(() => newSpec)}
                  onClose={() => setAiOpen(false)}
                />)}
```

- [ ] **Step 4: AppShell 게스트 칩**

20행 구조분해 교체:

```tsx
  const { enabled: authEnabled, me, logout, isGuest, requestLogin } = useAuth()
```

61-72행 사용자 칩 블록 교체:

```tsx
        {authEnabled && me && (
          <div style={{ ...userChip, marginTop: 'auto' }} title={isGuest ? '게스트 — GitHub 로그인하면 AI 를 쓸 수 있습니다' : `${me.username} · ${me.tenant} · ${me.roles.join(', ')}`}>
            <span aria-hidden style={avatar}>{isGuest ? 'G' : me.username.slice(0, 1).toUpperCase()}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isGuest ? '게스트' : me.username}</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {isGuest ? 'AI 는 로그인 필요' : `${me.tenant} · ${primaryRole(me.roles)}`}
              </span>
            </span>
            {isGuest ? (
              <button onClick={requestLogin} title="GitHub 로그인" style={loginChipBtn}>로그인</button>
            ) : (
              <button onClick={logout} aria-label="로그아웃" title="로그아웃" style={logoutBtn}>⎋</button>
            )}
          </div>
        )}
```

파일 하단 스타일에 추가:

```tsx
const loginChipBtn: CSSProperties = { flexShrink: 0, border: '1px solid var(--fl-primary)', background: 'transparent', color: 'var(--fl-primary)', cursor: 'pointer', fontSize: 11.5, fontWeight: 700, padding: '4px 9px', borderRadius: 999 }
```

- [ ] **Step 5: 빌드 검증**

Run(작업 디렉터리 `frontend/`): `npm run build` → Expected: 성공
Run: `npm run lint` → Expected: 에러 0

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/components/AssistantLoginGate.tsx frontend/src/routes/Editor.tsx frontend/src/routes/MockServerEditor.tsx frontend/src/app/AppShell.tsx
git commit -m "feat(assistant): 게스트 AI 로그인 게이트 카드 + 사이드바 게스트 칩 + presence 게스트 닉네임"
```

---

### Task 5: 라이브 검증 + 문서 갱신

**Files:**
- Modify: `CLAUDE.md` ("## 참고 문서" 직전에 최근 변경 섹션 추가)

**Interfaces:**
- Consumes: Task 1~4 전부(빌드된 백엔드 + 프론트 게이트).

- [ ] **Step 1: github 게스트 모드로 라이브 기동(헤드리스)**

작업 디렉터리 `backend/`, PowerShell — 임시 H2 파일로 격리해 백그라운드 기동:

```powershell
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"
$env:SPRING_PROFILES_ACTIVE="h2"
$env:FLOWLINK_AUTH_GITHUB_ENABLED="true"
$env:FLOWLINK_AUTH_JWT_SECRET="live-check-secret"
$env:FLOWLINK_H2_FILE="$env:TEMP\flowlink-guest-check"
.\gradlew.bat bootRun
```

(백그라운드 실행 후 `http://localhost:18080/actuator/health` 가 UP 될 때까지 대기.)

- [ ] **Step 2: 게스트/로그인 경계 curl 검증**

```powershell
# 1) 모드 발견
curl.exe -s http://localhost:18080/api/v1/auth/config
# Expected: {"enabled":true,"mode":"github"}

# 2) 게스트 /me
curl.exe -s http://localhost:18080/api/v1/auth/me
# Expected: {"username":"guest","tenant":"default","roles":["admin","editor","platform-admin"]}

# 3) 게스트 읽기/쓰기 허용
curl.exe -s -o NUL -w "%{http_code}" http://localhost:18080/api/v1/flows                      # Expected: 200
curl.exe -s -o NUL -w "%{http_code}" -X POST http://localhost:18080/api/v1/flows -H "content-type: application/json" -d "{\"name\":\"guest-live\"}"   # Expected: 201

# 4) AI 만 잠금
curl.exe -s -o NUL -w "%{http_code}" http://localhost:18080/api/v1/assistant/config           # Expected: 401
```

Expected: 위 주석대로. 하나라도 다르면 중단하고 원인 조사(systematic-debugging).

- [ ] **Step 3: 서버 종료**

bootRun 프로세스 종료(백그라운드 태스크 kill). 임시 H2 파일(`$env:TEMP\flowlink-guest-check.mv.db`)은 남아도 무해.

- [ ] **Step 3.5: (가능하면) 브라우저 스모크 — 없으면 수동 확인 항목으로 보고**

프론트 dev 서버(`frontend/`에서 `npm run dev`)를 띄우고 :5173 접속 확인이 가능하면: 로그인 화면 없이 대시보드 진입 → 에디터 ✨ 열면 AssistantLoginGate 카드 → 사이드바 "게스트 · 로그인" 칩 → 로그인 버튼이 디바이스 코드 모달을 띄움(실제 GitHub 인증까지는 불필요 — 코드 발급 화면 확인이면 충분, 닫기 ×로 복귀). 자동 브라우저 구동이 불가하면 이 항목을 "사용자 수동 확인 필요"로 최종 보고에 명시한다.

- [ ] **Step 4: CLAUDE.md 최근 변경 섹션 추가**

`CLAUDE.md` 의 `## 참고 문서` 바로 앞에 삽입:

```markdown
## 최근 변경 (2026-07-28) — 게스트 모드: github 모드에서 로그인 없이 앱 사용, AI만 로그인 게이트

설계: [docs/superpowers/specs/2026-07-28-guest-mode-design.md](docs/superpowers/specs/2026-07-28-guest-mode-design.md).
**github 모드(`FLOWLINK_AUTH_GITHUB_ENABLED=true`)의 의미 변경** — 앱 전체 잠금이 아니라 **"앱은 게스트에게 개방, GitHub 로그인 = AI 사용 + 신원 표시 게이트"**. 별도 플래그 없음(github 모드면 항상 게스트 허용).
- **백엔드**: [SecurityConfig](backend/src/main/kotlin/com/flowlink/security/SecurityConfig.kt) 3분기 — github 게스트 모드는 `/api/v1/assistant/**` 만 `authenticated()`, 나머지 permitAll(Bearer 는 계속 인식 — 로그인 사용자 triggeredBy·Copilot 연결 유지). 레거시 OIDC(issuer-uri) 모드는 기존 엄격 RBAC 그대로, dev 도 무변경. `/auth/me` 비인증은 github 모드에서 `guest`(전권) 반환. jwt-secret fail-closed 기동 가드 유지. `FLOWLINK_AUTH_ALLOWED_LOGINS` 는 "로그인(=AI) 가능 계정" 목록이 됨.
- **presence**: [PresenceHandshakeInterceptor](backend/src/main/kotlin/com/flowlink/presence/PresenceHandshakeInterceptor.kt) — github 모드에서 토큰 없는 WS 접속을 dev 방식(쿼리 name, 게스트 닉네임)으로 허용(무효 토큰은 여전히 401). 게스트도 커서·공동편집 참여.
- **프론트**: [AuthContext](frontend/src/auth/AuthContext.tsx) — github 모드 + 무토큰이면 로그인 화면 대신 **게스트 부트**(`isGuest`), `requestLogin()` 으로 [GitHubLogin](frontend/src/auth/GitHubLogin.tsx) 디바이스 로그인 **모달**. AI 패널 자리엔 [AssistantLoginGate](frontend/src/components/AssistantLoginGate.tsx)(에디터·Mock 편집기), 사이드바 칩은 "게스트 · 로그인". 무토큰 401 은 리로드하지 않음(리로드 루프 방지 — 토큰 있을 때만 폐기·재부트).
- 검증: [GuestModeSecurityTest](backend/src/test/kotlin/com/flowlink/security/GuestModeSecurityTest.kt)(@SpringBootTest — 게스트 CRUD 허용/assistant 401/로그인 200/무효토큰 401/guest me) + presence 인터셉터 단위 3종 + 라이브 curl(게스트 flows 200·POST 201·assistant 401) + tsc/build/oxlint.
- ⚠ **github 모드는 더 이상 앱 잠금이 아니다**(앱 접근 잠금은 레거시 OIDC 뿐). **플러그인 JAR 업로드도 게스트 가능**(dev 모드와 동일 수준 — 사내망 전제, 사용자 승인). 게스트 실행은 triggeredBy 미기록.
```

- [ ] **Step 5: 커밋**

```bash
git add CLAUDE.md
git commit -m "docs: 게스트 모드 최근 변경 기록 (github 모드 = 앱 개방 + AI 로그인 게이트)"
```
