package com.flowlink.security

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

/**
 * GitHub 로그인 기동 가드 — jwt-secret 은 필수(없으면 토큰 위조 → 기동 실패), allowed-logins 는 옵션(비면 전체 허용).
 * 검증기 생성이 곧 검증(init 블록)이다.
 */
class GithubAuthStartupValidatorTest {

    private fun props(secret: String?, logins: List<String>?) =
        AuthProperties(githubEnabled = true, jwtSecret = secret, tokenTtlHours = null, allowedLogins = logins, clientId = null)

    @Test
    fun `jwt-secret 과 allowed-logins 가 모두 있으면 통과`() {
        GithubAuthStartupValidator(props("strong-secret", listOf("alice")))
    }

    @Test
    fun `jwt-secret 미설정이면 기동 실패`() {
        assertThatThrownBy { GithubAuthStartupValidator(props(null, listOf("alice"))) }
            .isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining("FLOWLINK_AUTH_JWT_SECRET")
    }

    @Test
    fun `allowed-logins 비어도(전체 허용) 기동 성공`() {
        // 예외 없이 생성되면 OK — 화이트리스트 미설정은 "전체 허용"(의도된 기본, WARN 만).
        GithubAuthStartupValidator(props("strong-secret", emptyList()))
    }

    @Test
    fun `allowed-logins null 도 전체 허용으로 기동 성공`() {
        GithubAuthStartupValidator(props("strong-secret", null))
    }

    @Test
    fun `allows — 목록 있으면 그 계정만, 비면 누구나`() {
        val restricted = props("s", listOf("alice", "Bob"))
        assertThat(restricted.allows("alice")).isTrue()
        assertThat(restricted.allows("BOB")).isTrue()      // 대소문자 무시
        assertThat(restricted.allows("mallory")).isFalse()

        val open = props("s", emptyList())
        assertThat(open.allows("anyone")).isTrue()          // 화이트리스트 비면 전체 허용
    }
}
