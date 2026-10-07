package com.flowlink.desktop

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.context.support.GenericApplicationContext
import org.springframework.mock.web.MockHttpServletResponse
import java.net.URI
import java.nio.file.Path

class DesktopNavigationTest {
    @TempDir lateinit var directory: Path

    @Test fun `개인과 회사 진입 모두 작업 화면은 개인 앱 주소를 사용하고 공간을 명시한다`() {
        DesktopSession(directory.toString(), 18180).use { session ->
            GenericApplicationContext().use { context ->
                val controller = DesktopController(session, context)
                for ((runtime, space) in listOf("local" to "local%3Alocal", "server" to "server%3Apublic")) {
                    val issued = URI.create(session.browserUrl(runtime))
                    assertThat(issued.port).isEqualTo(18180)
                    val ticket = issued.rawQuery.substringAfter("ticket=")
                    val response = MockHttpServletResponse()
                    controller.open(ticket, runtime, response)
                    assertThat(response.status).isEqualTo(302)
                    assertThat(response.getHeader("Location")).isEqualTo("http://127.0.0.1:18180/flows?space=$space")
                    assertThat(response.getHeader("Set-Cookie")).contains("fl-local-18180", "HttpOnly")
                    val reused = MockHttpServletResponse()
                    controller.open(ticket, runtime, reused)
                    assertThat(reused.status).isEqualTo(401)
                }
                val default = MockHttpServletResponse()
                controller.open(session.browserUrl().substringAfter("ticket="), null, default)
                assertThat(default.getHeader("Location")).isEqualTo("http://127.0.0.1:18180/flows")
            }
        }
    }
}
