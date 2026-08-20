package com.flowlink.common.crypto

import com.flowlink.execution.config.ExecutionProperties
import com.flowlink.execution.engine.StateCrypto
import com.flowlink.secret.VaultProperties
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

/**
 * CryptoProvider 빈 선택 규칙 — transit 미사용이면 기존 StateCrypto(무회귀),
 * transit 사용이면 RoutingCrypto(쓰기 Transit·레거시 폴백), 토큰 없이 켜면 기동 실패(fail-closed).
 */
class CryptoConfigTest {

    private fun vault(transitEnabled: Boolean, token: String?) = VaultProperties(
        enabled = false, address = null, token = token, mount = null, path = null,
        configPath = null, refreshSeconds = null,
        transit = VaultProperties.Transit(enabled = transitEnabled, mount = null, key = null),
    )

    private fun exec() = ExecutionProperties(null, null, null, null, 0, "unit-test-secret", null)

    @Test
    fun `transit 미사용이면 기존 StateCrypto 그대로(무회귀)`() {
        val provider = CryptoConfig().cryptoProvider(vault(false, null), exec())
        assertThat(provider).isInstanceOf(StateCrypto::class.java)
    }

    @Test
    fun `transit 사용이면 RoutingCrypto(Transit 쓰기 + 레거시 폴백)`() {
        val provider = CryptoConfig().cryptoProvider(vault(true, "tkn"), exec())
        assertThat(provider).isInstanceOf(RoutingCrypto::class.java)
    }

    @Test
    fun `transit 을 켰는데 Vault 토큰이 없으면 기동 실패(fail-closed)`() {
        assertThatThrownBy { CryptoConfig().cryptoProvider(vault(true, null), exec()) }
            .isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining("토큰")
    }
}
