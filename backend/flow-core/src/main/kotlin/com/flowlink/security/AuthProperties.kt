package com.flowlink.security

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * flowlink.auth.* — **GitHub 로그인**(Copilot 과 동일한 디바이스 플로우) 기반 앱 인증.
 * GitHub 계정으로 로그인하면 앱이 자체 JWT(HMAC 서명)를 발급한다.
 *
 * @property githubEnabled true 면 GitHub 로그인 모드 — 앱이 자체 JWT 발급/검증. 브라우저는 무조건 로그인해야 앱을 쓴다.
 *   false/미설정이면 dev(permitAll).
 * @property guestEnabled github 모드에서만 의미. true 면 무인증(게스트) API 접근 허용 — **MCP 에이전트가 로그인 없이 쓰라고
 *   남겨 둔 스위치**(브라우저 UI 는 여전히 로그인 화면을 띄운다). AI(assistant)·프로토콜/환경 저장은 게스트여도 여전히 승인 사용자 필요.
 *   false/미설정(기본)이면 모든 API 가 로그인 필수(부트스트랩·SPA 셸 제외). env `FLOWLINK_AUTH_GUEST_ENABLED`.
 * @property jwtSecret 앱 JWT 서명/검증 HMAC 시크릿(SHA-256 파생 32B). 미설정이면 [AppJwt] 가 기동 시 자동 생성해
 *   설정 테이블(auth.jwt-secret)에 저장(재시작에도 유지). env 로 주면 그것이 우선.
 * @property tokenTtlHours 발급 JWT 유효시간(기본 720h=30일 — 디바이스 로그인이 오래가게). env `FLOWLINK_AUTH_TOKEN_TTL_HOURS`.
 * @property clientId GitHub 디바이스 플로우 client_id(기본 Copilot 공개 client — 코파일럿 로그인과 동일 UX).
 */
@ConfigurationProperties(prefix = "flowlink.auth")
class AuthProperties(
    githubEnabled: Boolean? = null,
    guestEnabled: Boolean? = null,
    jwtSecret: String? = null,
    tokenTtlHours: Int? = null,
    clientId: String? = null,
) {
    val githubEnabled: Boolean = githubEnabled ?: false
    val guestEnabled: Boolean = guestEnabled ?: false
    val jwtSecret: String? = jwtSecret?.takeIf { it.isNotBlank() }
    val tokenTtlHours: Int = if (tokenTtlHours == null || tokenTtlHours <= 0) 720 else tokenTtlHours
    val clientId: String = clientId?.takeIf { it.isNotBlank() } ?: "Iv1.b507a08c87ecfe98"
}
