package com.flowlink.security

import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

/**
 * GitHub 로그인 기동 가드 — 서명 시크릿(env FLOWLINK_AUTH_JWT_SECRET)이
 * 없으면 기동 실패(토큰 위조 방지). 검증기 생성이 곧 검증(init 블록)이다.
 */
class GithubAuthStartupValidatorTest {

    private fun props(secret: String?) = AuthProperties(githubEnabled = true, jwtSecret = secret, tokenTtlHours = null, clientId = null)

    @Test
    fun `env 시크릿 있으면 통과`() {
        GithubAuthStartupValidator(AppJwt(props("strong-secret")))
    }

    @Test
    fun `env 시크릿 없으면 기동 실패`() {
        assertThatThrownBy { GithubAuthStartupValidator(AppJwt(props(null))) }
            .isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining("FLOWLINK_AUTH_JWT_SECRET")
    }
}
