package com.flowlink.security;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * flowlink.security.* — IdP 비종속(OIDC 표준) 보안 설정.
 *
 * @param tenantClaim JWT 에서 테넌트 식별자를 읽을 클레임 이름. (IdP/시장 결정 후 매핑 조정)
 */
@ConfigurationProperties(prefix = "flowlink.security")
public record SecurityProperties(String tenantClaim) {
    public SecurityProperties {
        if (tenantClaim == null || tenantClaim.isBlank()) {
            tenantClaim = "tenant";
        }
    }
}
