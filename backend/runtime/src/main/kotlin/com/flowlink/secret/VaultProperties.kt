package com.flowlink.secret

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * flowlink.vault.* — HashiCorp Vault Transit(KEK) 봉투 암호화·AppRole 인증 설정.
 * `@ConfigurationPropertiesScan` 이 자동 등록한다. 스위치는 [Transit.enabled] 뿐.
 *
 * @property address Vault 주소(기본 http://localhost:8200 — infra 도커 dev 서버).
 * @property token Vault 정적 토큰(dev 루트 토큰 등). AppRole 미설정 시 사용.
 */
@ConfigurationProperties(prefix = "flowlink.vault")
class VaultProperties(
    address: String? = null,
    token: String? = null,
    transit: Transit? = null,
    approle: AppRole? = null,
) {
    val address: String = address?.trimEnd('/')?.takeIf { it.isNotBlank() } ?: "http://localhost:8200"
    val token: String? = token?.takeIf { it.isNotBlank() }
    val transit: Transit = transit ?: Transit()
    val approle: AppRole = approle ?: AppRole()

    /**
     * Vault Transit(KEK) 봉투 암호화 — enabled=true 면 앱 암호화(시크릿·재개 스냅샷·토큰)를
     * Transit `encrypt/decrypt/{key}` 로 위임한다(키는 Vault 밖으로 안 나옴). address/token 은 위 공용값 재사용.
     */
    class Transit(enabled: Boolean? = null, mount: String? = null, key: String? = null) {
        val enabled: Boolean = enabled ?: false
        val mount: String = mount?.trim('/')?.takeIf { it.isNotBlank() } ?: "transit"
        val key: String = key?.trim('/')?.takeIf { it.isNotBlank() } ?: "flowlink"
    }

    /**
     * AppRole 인증 — role_id/secret_id 를 두면 static 토큰 대신 `auth/{mount}/login` 으로
     * 단명 토큰을 자동 발급·갱신한다(정석: 고정 토큰을 서버에 두지 않음). 둘 다 있어야 활성.
     */
    class AppRole(roleId: String? = null, secretId: String? = null, mount: String? = null) {
        val roleId: String? = roleId?.takeIf { it.isNotBlank() }
        val secretId: String? = secretId?.takeIf { it.isNotBlank() }
        val mount: String = mount?.trim('/')?.takeIf { it.isNotBlank() } ?: "approle"
        val configured: Boolean get() = roleId != null && secretId != null
    }
}
