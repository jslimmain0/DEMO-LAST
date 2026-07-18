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
 * @property path 시크릿이 담긴 KV 경로(기본 flowlink → GET secret/data/flowlink).
 * @property refreshSeconds 캐시 TTL(초, 기본 60) — 실행마다 네트워크 호출을 피한다.
 */
@ConfigurationProperties(prefix = "flowlink.vault")
class VaultProperties(
    enabled: Boolean? = null,
    address: String? = null,
    token: String? = null,
    mount: String? = null,
    path: String? = null,
    refreshSeconds: Long? = null,
) {
    val enabled: Boolean = enabled ?: false
    val address: String = address?.trimEnd('/')?.takeIf { it.isNotBlank() } ?: "http://localhost:8200"
    val token: String? = token?.takeIf { it.isNotBlank() }
    val mount: String = mount?.trim('/')?.takeIf { it.isNotBlank() } ?: "secret"
    val path: String = path?.trim('/')?.takeIf { it.isNotBlank() } ?: "flowlink"
    val refreshSeconds: Long = if (refreshSeconds == null || refreshSeconds <= 0) 60L else refreshSeconds
}
