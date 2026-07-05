package com.flowlink.security

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * flowlink.security.* — IdP 비종속(OIDC 표준) 보안 설정.
 *
 * @property tenantClaim JWT 에서 테넌트 식별자를 읽을 클레임 이름. (IdP/시장 결정 후 매핑 조정)
 */
@ConfigurationProperties(prefix = "flowlink.security")
class SecurityProperties(tenantClaim: String?) {
    /** 미설정/공백이면 "tenant" 기본값. */
    @get:JvmName("tenantClaim")
    val tenantClaim: String =
        if (tenantClaim.isNullOrBlank()) "tenant" else tenantClaim
}
