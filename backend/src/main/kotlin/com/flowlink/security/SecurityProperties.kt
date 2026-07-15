package com.flowlink.security

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * flowlink.security.* — IdP 비종속(OIDC 표준) 보안 설정.
 *
 * @property tenantClaim JWT 에서 테넌트(팀) 식별자를 읽을 클레임 이름.
 * @property clientId 프론트(SPA)가 사용할 OIDC public 클라이언트 id — `/api/v1/auth/config` 로 노출.
 * @property corsOrigins API 경로(/api 이하) CORS 허용 오리진 목록.
 */
@ConfigurationProperties(prefix = "flowlink.security")
class SecurityProperties(tenantClaim: String?, clientId: String?, corsOrigins: List<String>?) {
    /** 미설정/공백이면 "tenant" 기본값. */
    @get:JvmName("tenantClaim")
    val tenantClaim: String =
        if (tenantClaim.isNullOrBlank()) "tenant" else tenantClaim

    /** 미설정/공백이면 "flowlink-web" 기본값. */
    @get:JvmName("clientId")
    val clientId: String =
        if (clientId.isNullOrBlank()) "flowlink-web" else clientId

    /** 미설정이면 로컬 개발 기본 3종. */
    @get:JvmName("corsOrigins")
    val corsOrigins: List<String> =
        if (corsOrigins.isNullOrEmpty())
            listOf("http://localhost:5173", "http://localhost:3000", "http://localhost:18080")
        else corsOrigins
}
