package com.flowlink.security

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * flowlink.auth.* — **GitHub 로그인**(Copilot 과 동일한 디바이스 플로우) 기반 앱 인증.
 * Keycloak/OIDC 대신 GitHub 계정으로 로그인하면 앱이 자체 JWT(HMAC 서명)를 발급한다.
 *
 * @property githubEnabled true 면 GitHub 로그인 활성(앱이 자체 JWT 검증 → 인증 필수). false/미설정이면 dev(permitAll).
 * @property jwtSecret 앱 JWT 서명/검증 HMAC 시크릿(SHA-256 파생 32B). 미설정 시 dev 폴백 + WARN(운영 필수 설정).
 * @property tokenTtlHours 발급 JWT 유효시간(기본 12h).
 * @property allowedLogins 접근 허용 GitHub 로그인 화이트리스트(비면 GitHub 인증한 누구나 — dev). 운영은 반드시 설정 권장.
 * @property clientId GitHub 디바이스 플로우 client_id(기본 Copilot 공개 client — 코파일럿 로그인과 동일 UX).
 */
@ConfigurationProperties(prefix = "flowlink.auth")
class AuthProperties(
    githubEnabled: Boolean? = null,
    jwtSecret: String? = null,
    tokenTtlHours: Int? = null,
    allowedLogins: List<String>? = null,
    clientId: String? = null,
) {
    val githubEnabled: Boolean = githubEnabled ?: false
    val jwtSecret: String? = jwtSecret?.takeIf { it.isNotBlank() }
    val tokenTtlHours: Int = if (tokenTtlHours == null || tokenTtlHours <= 0) 12 else tokenTtlHours
    val allowedLogins: List<String> = allowedLogins?.map { it.trim().lowercase() }?.filter { it.isNotEmpty() } ?: emptyList()
    val clientId: String = clientId?.takeIf { it.isNotBlank() } ?: "Iv1.b507a08c87ecfe98"

    /** 허용 여부 — 화이트리스트가 비면 누구나(dev), 있으면 목록만. */
    fun allows(login: String): Boolean = allowedLogins.isEmpty() || allowedLogins.contains(login.lowercase())
}
