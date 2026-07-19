package com.flowlink.security

import com.flowlink.secret.VaultProperties
import com.flowlink.secret.VaultSecretSource
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

/**
 * GitHub 로그인 기동 가드 — 서명 시크릿(env FLOWLINK_AUTH_JWT_SECRET 또는 Vault flowlink-config/jwt-secret)이
 * 없으면 기동 실패(토큰 위조 방지). allowed-logins 는 옵션(비면 전체 허용). 검증기 생성이 곧 검증(init 블록)이다.
 */
class GithubAuthStartupValidatorTest {

    private fun props(secret: String?, logins: List<String>?) =
        AuthProperties(githubEnabled = true, jwtSecret = secret, tokenTtlHours = null, allowedLogins = logins, clientId = null)

    /** Vault 비활성(appSecret 항상 null). */
    private fun vaultOff() = VaultSecretSource(VaultProperties(enabled = false, address = null, token = null, mount = null, path = null, configPath = null, refreshSeconds = null))

    /** Vault 가 config 경로에 jwt-secret 을 제공. */
    private fun vaultWith(secret: String) = object : VaultSecretSource(VaultProperties(false, null, null, null, null, null, null)) {
        override fun appSecret(key: String): String? = if (key == AppJwt.VAULT_JWT_KEY) secret else null
    }

    @Test
    fun `env 시크릿 있으면 통과`() {
        GithubAuthStartupValidator(AppJwt(props("strong-secret", listOf("alice")), vaultOff()), props("strong-secret", listOf("alice")))
    }

    @Test
    fun `env 없고 Vault 에 시크릿 있으면 통과`() {
        val p = props(null, listOf("alice"))
        GithubAuthStartupValidator(AppJwt(p, vaultWith("from-vault")), p)
    }

    @Test
    fun `env·Vault 둘 다 없으면 기동 실패`() {
        val p = props(null, listOf("alice"))
        assertThatThrownBy { GithubAuthStartupValidator(AppJwt(p, vaultOff()), p) }
            .isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining("FLOWLINK_AUTH_JWT_SECRET")
    }

    @Test
    fun `allowed-logins 비어도(전체 허용) 기동 성공`() {
        val p = props("strong-secret", emptyList())
        GithubAuthStartupValidator(AppJwt(p, vaultOff()), p)
    }

    @Test
    fun `allows — 목록 있으면 그 계정만, 비면 누구나`() {
        val restricted = props("s", listOf("alice", "Bob"))
        assertThat(restricted.allows("alice")).isTrue()
        assertThat(restricted.allows("BOB")).isTrue()      // 대소문자 무시
        assertThat(restricted.allows("mallory")).isFalse()
        assertThat(props("s", emptyList()).allows("anyone")).isTrue()   // 화이트리스트 비면 전체 허용
    }
}
