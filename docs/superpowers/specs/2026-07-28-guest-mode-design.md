# 게스트 모드 — GitHub 로그인 없이 앱 사용, AI만 로그인 게이트 (2026-07-28)

## 목적

GitHub 로그인 모드(`FLOWLINK_AUTH_GITHUB_ENABLED=true`)에서 **로그인 없이도 앱 전체를 사용**할 수
있게 한다. 로그인이 필요한 것은 **AI 어시스턴트뿐**(Copilot 이 사용자의 GitHub 토큰을 쓰므로 본질적
제약이기도 하다).

**의미 변경**: github 모드는 더 이상 "앱 전체 잠금"이 아니다 —
**"앱은 열려 있고, GitHub 로그인 = AI 사용 + 신원 표시 게이트"**.
`FLOWLINK_AUTH_ALLOWED_LOGINS` 화이트리스트는 "로그인(=AI 사용) 가능한 계정" 목록이 된다.
플래그 추가 없음(github 모드면 항상 게스트 허용 — 사용자 결정).

## 사용자 결정 사항

| 결정 | 내용 |
|---|---|
| 게스트 권한 | **전부 허용** — 플로우 편집/실행·Mock·시크릿·설정·트리거·**플러그인 업로드까지**. 잠기는 건 AI 어시스턴트만 |
| 켜는 방식 | 별도 플래그 없이 **github 모드면 항상 게스트 허용** |
| 플러그인 JAR 업로드 | **게스트 허용**(임의 코드 실행임을 고지했고 사내망 전제로 수용 — dev 모드와 동일 수준) |

## 설계 (승인됨)

접근법: **github 모드 보안 규칙 재정의**. 익명 권한 부여(Spring anonymous authorities)나 게스트 JWT
발급 없이, github 모드에서 assistant 경로만 인증 필수로 하고 나머지를 permitAll 로 연다.
github 모드는 "로그인=전권(FULL_ROLES)"이라 역할 구분이 무의미하므로 RBAC 세분 규칙은 로그인
사용자에게도 실익이 없다(레거시 OIDC 모드는 기존 RBAC 그대로 유지).

### 1. 백엔드 — SecurityConfig 3분기

`SecurityConfig` 에 `AuthProperties` 주입, 분기 순서: **github 모드 → OIDC(issuer) 모드 → dev**.

- **github 모드**(`githubEnabled=true`, JwtDecoder=AppJwt):
  - `/api/v1/assistant/**` → `authenticated()` (익명 제외 — AI 채팅·스킬·Copilot 연결·instructions 전부).
    로그인 사용자는 FULL_ROLES 라 세부 역할 규칙 불필요.
  - 그 외 전부(permitAll) — `/api/**`·SPA 셸·PUBLIC_PATHS 포함.
  - `oauth2ResourceServer`(JwtRoleConverter) + `TenantClaimFilter` 는 **유지** — Bearer 를 실은
    로그인 사용자는 신원 인식(triggeredBy·Copilot 연결·presence 이름). JWT 없으면 default 테넌트
    (TenantClaimFilter 는 JWT 없을 때 아무것도 안 함 → TenantContext 기본값).
  - 무효/만료 Bearer 는 리소스 서버가 401 → 프론트 인터셉터가 토큰 폐기 후 게스트로 재부트(기존 동작).
- **OIDC 모드**(issuer-uri, githubEnabled=false): 기존 엄격 RBAC 규칙 **무변경**.
- **dev 모드**(둘 다 없음): 현행 permitAll 무변경.
- `GithubAuthStartupValidator` 의 **jwt-secret 필수(fail-closed)는 유지** — 로그인 토큰 위조 방지는
  게스트 모드에서도 그대로 필요. allowed-logins WARN 문구는 "로그인(=AI) 허용 계정" 의미로 갱신.

### 2. 백엔드 — /auth/me 게스트 응답

github 모드에서 비인증 호출이면 `username="guest"` + `tenant=default` + 전권 역할(admin/editor/
platform-admin)을 반환 — 프론트 `usePermissions()` 게이팅이 게스트를 읽기전용으로 잠그지 않게.
(dev 모드의 "dev" 가짜 사용자와 같은 패턴, 이름만 구분.)

`/auth/config` 는 무변경(mode="github") — 프론트가 "github 모드 = 게스트 허용"으로 해석한다.

### 3. 프론트 — AuthContext 게스트 부트 + 로그인 모달

- boot: github 모드 + 토큰 없음 → `needsLogin=true` 대신 **게스트로 진입**(익명 `/auth/me` 조회,
  실패 시 로컬 게스트 폴백). `AuthState` 에 `isGuest` 추가.
- **`requestLogin()`**: 기존 전체화면 `GitHubLogin`(디바이스 플로우)을 **모달**로 재사용해 온디맨드
  로그인. 성공 시 리로드(재부트 → 인증 상태, 서버의 GithubLoginEvent 로 Copilot 자동 연결).
- 401 인터셉터·만료 토큰 처리 기존 그대로(폐기 후 리로드 = 게스트 재부트, 무한루프 없음 — 게스트는
  토큰이 없어 401 유발 안 함).

### 4. 프론트 — AI 게이팅

- `AssistantPanel`·`MockAssistantPanel`: `isGuest` 면 채팅 UI 대신 안내 카드
  ("AI 어시스턴트는 GitHub 로그인 후 사용할 수 있습니다") + **[GitHub 로그인]** 버튼(`requestLogin()`).
- 사이드바 사용자 칩(AppShell): 게스트면 "게스트" 표시 + 로그인 버튼, 로그인 상태는 기존
  (사용자명·로그아웃) 그대로.

### 5. presence/협업 WebSocket

`PresenceHandshakeInterceptor` 에 github 모드 분기: 쿼리 `?token=` 이 있으면 기존 JWT 검증(이름=
preferred_username), **없으면 dev 방식 허용**(쿼리 `?name=`, 게스트 닉네임) — 게스트도 커서·공동
편집 참여. flow 접근 검사는 default 테넌트 기준(github 모드 데이터는 전부 default).
프론트 `lib/presence.ts`: 토큰 없으면 dev 모드처럼 `fl:nick` 닉네임 전송.

### 6. 실행 기록

게스트 실행은 `triggeredBy=null`(현행 dev 모드와 동일 — `currentUser()` 가 JWT 없으면 null).
로그인 사용자는 사용자명 기록 유지. 변경 없음.

## 에러 처리

- 게스트가 assistant API 를 직접 호출(우회) → 서버 401 (UI 게이팅과 무관하게 서버가 차단).
- localStorage 의 만료 토큰 → 첫 API 401 → 토큰 폐기 → 게스트로 재부트(로그인 강제 아님).
- WS 핸드셰이크에 무효 토큰 → 401 거절(현행) — 프론트는 토큰이 있을 때만 token 파라미터를 싣는다.

## 검증 계획

- 백엔드 단위: github 모드 SecurityFilterChain — 게스트 GET/POST `/api/v1/flows` 200,
  `/api/v1/assistant/config` 401, 유효 JWT 로 assistant 200, 무효 JWT 는 어디서든 401.
- 라이브(헤드리스): github 모드 기동 → 무토큰으로 플로우 CRUD/실행 완주, assistant 401,
  디바이스 로그인 후 assistant 200.
- 브라우저: 게스트 진입(로그인 화면 없이 대시보드), AI 패널 로그인 카드, 로그인 모달 → AI 사용,
  사용자 칩 게스트/로그인 전환. 프론트 tsc/build/oxlint.

## 의식적 수용 (⚠)

- **github 모드가 앱 잠금이 아니게 됨** — 앱 접근 자체를 잠그는 모드는 이제 레거시 OIDC 뿐(의도된 변경).
- **플러그인 JAR 업로드가 게스트에게 열림**(임의 코드 실행) — dev 모드와 동일 수준, 사내망 전제(사용자 승인).
- 게스트 실행은 triggeredBy 미기록(익명), 시크릿/설정도 게스트 수정 가능 — 전부 "AI만 잠금" 결정의 귀결.
