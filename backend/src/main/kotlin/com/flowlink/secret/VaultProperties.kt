package com.flowlink.secret

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * flowlink.vault.* — HashiCorp Vault(KV v2)에서 시크릿을 끌어와 시크릿 볼트에 오버레이한다.
 * `@ConfigurationPropertiesScan` 이 자동 등록한다.
 *
 * enabled=false(기본)면 완전 비활성 → 기존 DB 시크릿만 동작(무회귀). 켜면 Vault 값이 **org 공통 기본층**이 되고,
 * 같은 이름의 DB/환경 시크릿이 그 위를 덮어쓴다(DB > Vault). 값은 실행 시 `{{ 이름@secret }}` 로만 쓰인다.
 *
 * @property address Vault 주소(기본 http://localhost:8200 — infra 도커 dev 서버).
 * @property token Vault 토큰(dev 루트 토큰 또는 AppRole 발급 토큰). 미설정이면 비활성.
 * @property mount KV v2 시크릿 엔진 마운트 경로(기본 secret).
 * @property path 워크플로 시크릿(`{{ 이름@secret }}`)이 담긴 KV 경로(기본 flowlink → GET secret/data/flowlink).
 * @property configPath 앱 설정 비밀(jwt-secret 등)이 담긴 KV 경로(기본 flowlink-config). **워크플로에 노출되지 않는다** —
 *   서명키 등 앱 내부 비밀을 워크플로 바인딩과 분리하기 위한 별도 경로.
 * @property refreshSeconds 캐시 TTL(초, 기본 60) — 실행마다 네트워크 호출을 피한다.
 */
@ConfigurationProperties(prefix = "flowlink.vault")
class VaultProperties(
    enabled: Boolean? = null,
    address: String? = null,
    token: String? = null,
    mount: String? = null,
    path: String? = null,
    configPath: String? = null,
    refreshSeconds: Long? = null,
    transit: Transit? = null,
    approle: AppRole? = null,
) {
    val enabled: Boolean = enabled ?: false
    val address: String = address?.trimEnd('/')?.takeIf { it.isNotBlank() } ?: "http://localhost:8200"
    val token: String? = token?.takeIf { it.isNotBlank() }
    val mount: String = mount?.trim('/')?.takeIf { it.isNotBlank() } ?: "secret"
    val path: String = path?.trim('/')?.takeIf { it.isNotBlank() } ?: "flowlink"
    val configPath: String = configPath?.trim('/')?.takeIf { it.isNotBlank() } ?: "flowlink-config"
    val refreshSeconds: Long = if (refreshSeconds == null || refreshSeconds <= 0) 60L else refreshSeconds
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
