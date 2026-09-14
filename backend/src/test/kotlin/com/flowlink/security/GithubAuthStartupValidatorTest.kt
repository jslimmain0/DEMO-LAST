package com.flowlink.security

import com.flowlink.secret.VaultProperties
import com.flowlink.secret.VaultSecretSource
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

/**
 * GitHub 로그인 기동 가드 — 서명 시크릿(env FLOWLINK_AUTH_JWT_SECRET 또는 Vault flowlink-config/jwt-secret)이
 * 없으면 기동 실패(토큰 위조 방지). 검증기 생성이 곧 검증(init 블록)이다.
 */
class GithubAuthStartupValidatorTest {

    private fun props(secret: String?) = AuthProperties(githubEnabled = true, jwtSecret = secret, tokenTtlHours = null, clientId = null)

    /** Vault 비활성(appSecret 항상 null). */
    private fun vaultOff() = VaultSecretSource(VaultProperties(enabled = false, address = null, token = null, mount = null, path = null, configPath = null, refreshSeconds = null))

    /** Vault 가 config 경로에 jwt-secret 을 제공. */
    private fun vaultWith(secret: String) = object : VaultSecretSource(VaultProperties(false, null, null, null, null, null, null)) {
        override fun appSecret(key: String): String? = if (key == AppJwt.VAULT_JWT_KEY) secret else null
    }

    @Test
    fun `env 시크릿 있으면 통과`() {
        GithubAuthStartupValidator(AppJwt(props("strong-secret"), vaultOff()))
    }

    @Test
    fun `env 없고 Vault 에 시크릿 있으면 통과`() {
        GithubAuthStartupValidator(AppJwt(props(null), vaultWith("from-vault")))
    }

    @Test
    fun `env·Vault 둘 다 없으면 기동 실패`() {
        assertThatThrownBy { GithubAuthStartupValidator(AppJwt(props(null), vaultOff())) }
            .isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining("FLOWLINK_AUTH_JWT_SECRET")
    }
}
