package com.flowlink.security

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

/**
 * GitHub 로그인 fail-closed 가드 — 활성 시 jwt-secret·allowed-logins 둘 다 없으면 기동을 막아야 한다
 * (없으면 토큰 위조 / 누구나 admin). 검증기 생성이 곧 검증(init 블록)이다.
 */
class GithubAuthStartupValidatorTest {

    private fun props(secret: String?, logins: List<String>?) =
        AuthProperties(githubEnabled = true, jwtSecret = secret, tokenTtlHours = null, allowedLogins = logins, clientId = null)

    @Test
    fun `jwt-secret 과 allowed-logins 가 모두 있으면 통과`() {
        // 예외 없이 생성되면 OK
        GithubAuthStartupValidator(props("strong-secret", listOf("alice")))
    }

    @Test
    fun `jwt-secret 미설정이면 기동 실패`() {
        assertThatThrownBy { GithubAuthStartupValidator(props(null, listOf("alice"))) }
            .isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining("FLOWLINK_AUTH_JWT_SECRET")
    }

    @Test
    fun `allowed-logins 비면 기동 실패(fail-open 차단)`() {
        assertThatThrownBy { GithubAuthStartupValidator(props("strong-secret", emptyList())) }
            .isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining("FLOWLINK_AUTH_ALLOWED_LOGINS")
    }

    @Test
    fun `allowed-logins null 도 비어있음으로 취급해 실패`() {
        assertThatThrownBy { GithubAuthStartupValidator(props("strong-secret", null)) }
            .isInstanceOf(IllegalStateException::class.java)
    }

    @Test
    fun `allows 는 화이트리스트 목록만 허용`() {
        val p = props("s", listOf("alice", "Bob"))
        assertThat(p.allows("alice")).isTrue()
        assertThat(p.allows("BOB")).isTrue()   // 대소문자 무시
        assertThat(p.allows("mallory")).isFalse()
    }
}
