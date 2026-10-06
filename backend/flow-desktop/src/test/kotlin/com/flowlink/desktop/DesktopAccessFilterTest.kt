package com.flowlink.desktop

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import java.nio.file.Path

class DesktopAccessFilterTest {
    @TempDir lateinit var directory: Path

    @Test fun `관리 API는 로컬 키와 안전한 origin을 요구하고 Mock HTML은 별도 origin을 쓴다`() {
        DesktopSession(directory.toString(), 18180).use { session ->
            val filter = DesktopAccessFilter(session)
            fun call(path: String = "/api/v1/flows", key: String? = null, origin: String? = null, host: String = "127.0.0.1:18180"): MockHttpServletResponse {
                val req = MockHttpServletRequest("GET", path).apply {
                    serverPort = 18180; addHeader("Host", host)
                    key?.let { addHeader("X-FlowLink-Local", it) }; origin?.let { addHeader("Origin", it) }
                }
                return MockHttpServletResponse().also { response -> filter.doFilter(req, response) { _, res -> res.writer.write("allowed") } }
            }
            assertThat(call().status).isEqualTo(401)
            assertThat(call(key = session.token).contentAsString).isEqualTo("allowed")
            for (path in listOf("/api/v1/plugins", "/api/v1/plugins/scripts", "/api/v1/plugins/api", "/api/v1/transforms", "/api/v1/transforms/plugin/preview", "/api/v1/codecs"))
                assertThat(call(path, key = session.token).status).isEqualTo(403)
            assertThat(call("/api/v1/remote/api/v1/plugins/scripts", key = session.token).contentAsString).isEqualTo("allowed")
            assertThat(call("/api/v1/secrets", key = session.token).contentAsString).isEqualTo("allowed")
            assertThat(call(key = session.token, origin = "https://attacker.example").status).isEqualTo(403)
            assertThat(call(key = session.token, host = "attacker.example:18180").status).isEqualTo(403)
            assertThat(call(key = session.token, origin = "http://localhost:18180").status).isEqualTo(403)
            assertThat(call("/mock/test/page").getHeader("Location")).isEqualTo("http://localhost:18180/mock/test/page")
            assertThat(call("/mock/test/page", host = "localhost:18180").contentAsString).isEqualTo("allowed")
            assertThat(call("/api/v1/flows", key = session.token, host = "localhost:18180").status).isEqualTo(403)
            assertThat(call("/relay/run/cb/wait", host = "localhost:18180").contentAsString).isEqualTo("allowed")
        }
    }
}
