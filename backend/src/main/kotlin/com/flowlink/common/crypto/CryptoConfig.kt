package com.flowlink.common.crypto

import com.flowlink.execution.engine.StateCrypto
import com.flowlink.secret.VaultProperties
import com.flowlink.secret.VaultTokenSource
import org.slf4j.LoggerFactory
import org.springframework.boot.ApplicationRunner
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/**
 * 앱 저장 암호화([CryptoProvider]) 단일 빈 — 시크릿·재개 스냅샷·어시스턴트 토큰이 공유한다.
 *
 * - transit 미사용(기본): [StateCrypto](고정키 AES-GCM) — 사내망 전제.
 * - `flowlink.vault.transit.enabled=true`: 쓰기는 Vault Transit(KEK — 키가 Vault 밖으로 안 나옴),
 *   읽기는 접두사 라우팅으로 레거시 데이터 폴백([RoutingCrypto]). 토큰 미설정이면 **기동 실패**(fail-closed —
 *   조용히 로컬 키로 내려앉으면 운영자가 KEK 보호를 받는 줄 착각한다).
 */
@Configuration
class CryptoConfig {

    /** Vault 인증 토큰 소스 단일 빈 — Transit 이 사용한다. */
    @Bean
    fun vaultTokenSource(vault: VaultProperties): VaultTokenSource = VaultTokenSource.of(vault)

    @Bean
    fun cryptoProvider(vault: VaultProperties, tokens: VaultTokenSource): CryptoProvider {
        val local = StateCrypto()
        if (!vault.transit.enabled) {
            log.warn("앱 암호화 = Transit 미사용 — 고정키로 로컬 암호화(사내망 전제)")
            return local
        }
        check(tokens.available) {
            "Vault Transit 이 켜져 있는데 Vault 인증이 없습니다 — FLOWLINK_VAULT_TOKEN 또는 AppRole(role_id/secret_id)을 설정하세요(fail-closed)"
        }
        log.info("앱 암호화 = Vault Transit (mount={}, key={}) + 레거시 폴백", vault.transit.mount, vault.transit.key)
        return RoutingCrypto(TransitCrypto(vault, tokens), local)
    }

    /** transit 모드 기동 헬스체크 — encrypt→decrypt 왕복 1회. 실패 시 기동 중단(늦은 런타임 실패 방지). */
    @Bean
    fun transitStartupCheck(vault: VaultProperties, crypto: CryptoProvider): ApplicationRunner = ApplicationRunner {
        if (vault.transit.enabled) {
            val probe = "flowlink-transit-healthcheck"
            val roundtrip = crypto.decrypt(crypto.encrypt(probe))
            check(roundtrip == probe) { "Vault Transit 헬스체크 실패 — 왕복 결과 불일치" }
            log.info("Vault Transit 헬스체크 OK ({}/{})", vault.transit.mount, vault.transit.key)
        }
    }

    companion object {
        private val log = LoggerFactory.getLogger(CryptoConfig::class.java)
    }
}
