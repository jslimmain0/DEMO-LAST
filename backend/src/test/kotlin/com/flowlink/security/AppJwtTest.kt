package com.flowlink.security

import com.flowlink.core.repository.AppSettingRepository
import com.flowlink.settings.SettingsService
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.Mockito

/** AppJwt 서명 시크릿 해석 — env 우선, 다음 설정 테이블 값 재사용(둘 다 있으면 자동 생성·저장 없음). */
class AppJwtTest {

    private class FakeSettings(var stored: String?) : SettingsService(Mockito.mock(AppSettingRepository::class.java)) {
        var puts = 0
        override fun get(key: String): String? = stored
        override fun put(key: String, value: String?) { puts++; stored = value }
    }

    @Test
    fun `env 시크릿이 있으면 설정 테이블에 저장하지 않는다`() {
        val settings = FakeSettings(null)
        val jwt = AppJwt(AuthProperties(jwtSecret = "env-secret"), settings)
        assertThat(settings.puts).isZero()
        assertThat(jwt.decoder().decode(jwt.issue("octocat")).subject).isEqualTo("octocat")
    }

    @Test
    fun `설정 테이블 값이 있으면 그대로 재사용한다`() {
        val settings = FakeSettings("db-secret")
        val jwt = AppJwt(AuthProperties(), settings)
        assertThat(settings.puts).isZero()
        assertThat(settings.stored).isEqualTo("db-secret")
        assertThat(jwt.decoder().decode(jwt.issue("octocat")).subject).isEqualTo("octocat")
    }
}
