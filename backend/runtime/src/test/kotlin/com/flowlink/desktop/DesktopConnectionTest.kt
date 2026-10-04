package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.context.ApplicationEventPublisher
import org.springframework.mock.web.MockHttpServletRequest
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicReference

class DesktopConnectionTest {
    @TempDir lateinit var directory: Path

    @Test fun `앱 로그인은 암호화해 재사용하고 원격 API에만 전달하며 만료 시 해제한다`() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val secret = "mock-jwt-must-never-appear-in-ui-or-file"
        var expire = false
        var requests = 0
        val metadata = AtomicReference(200 to """{"mcpUrl":"http://127.0.0.1:18090/mcp"}""")
        val started = mutableListOf<DesktopRemoteRunStarted>()
        server.createContext("/api/v1/") { exchange ->
            val (status, body) = when (exchange.requestURI.path) {
                "/api/v1/distribution" -> metadata.get()
                "/api/v1/auth/github/device/start" -> 200 to """{"sessionId":"session","verificationUri":"","userCode":"MOCK","intervalSec":2,"expiresIn":120}"""
                "/api/v1/auth/github/device/poll" -> 200 to """{"status":"ready","token":"$secret","login":"mock-user"}"""
                else -> {
                    assertThat(exchange.requestHeaders.getFirst("Authorization")).isEqualTo("Bearer $secret")
                    assertThat(exchange.requestHeaders.getFirst("X-FlowLink-Local")).isNull()
                    assertThat(exchange.requestHeaders.getFirst("X-FlowLink-Device")).isNotBlank()
                    if (exchange.requestMethod == "POST") {
                        val run = jacksonObjectMapper().readTree(exchange.requestBody)
                        assertThat(run.path("agentDeviceId").asText()).isEqualTo(exchange.requestHeaders.getFirst("X-FlowLink-Device"))
                        assertThat(run.path("clientExecutionId").asText()).isEqualTo(started.single().executionId.toString())
                    }
                    requests++
                    if (expire) 401 to "{}" else 200 to """[{"kind":"TEAM"}]"""
                }
            }
            val bytes = body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(status, bytes.size.toLong()); exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val base = "http://127.0.0.1:${server.address.port}"
            val mapper = jacksonObjectMapper()
            val events = ApplicationEventPublisher { if (it is DesktopRemoteRunStarted) started.add(it) }
            DesktopSession(directory.toString(), 18182).use { session ->
                val connection = DesktopConnection(session, mapper, events)
                connection.configure(base); connection.start()
                assertThat(connection.poll().toString()).doesNotContain(secret)
                assertThat(connection.view().connected).isTrue()
                assertThat(Files.readString(directory.resolve("server-session.enc"))).doesNotContain(secret).doesNotContain("mock-user")
                val restored = DesktopConnection(session, mapper, events)
                assertThat(restored.view().login).isEqualTo("mock-user")
                metadata.set(200 to """{"mcpUrl":"https://tools.example/mcp"}""")
                restored.refreshMetadata()
                assertThat(restored.view().mcpUrl).isEqualTo("https://tools.example/mcp")
                assertThat(restored.view().login).isEqualTo("mock-user")
                assertThat(restored.view().connected).isTrue()
                metadata.set(503 to "{}")
                restored.refreshMetadata()
                assertThat(restored.view().mcpUrl).isEqualTo("https://tools.example/mcp")
                assertThat(restored.view().connected).isTrue()
                metadata.set(200 to """{"mcpUrl":"http://untrusted.example/mcp"}""")
                restored.refreshMetadata()
                assertThat(restored.view().mcpUrl).isEqualTo("https://tools.example/mcp")
                assertThat(DesktopConnection(session, mapper, events).view()).isEqualTo(restored.view())
                val req = MockHttpServletRequest("GET", "/api/v1/remote/workspaces")
                assertThat(restored.forward(req).statusCode.value()).isEqualTo(200)
                val staleAccount = MockHttpServletRequest("GET", "/api/v1/remote/workspaces").apply { addHeader("X-FlowLink-Account", "previous-user") }
                assertThat(restored.forward(staleAccount).statusCode.value()).isEqualTo(409)
                val staleServer = MockHttpServletRequest("GET", "/api/v1/remote/workspaces").apply { addHeader("X-FlowLink-Server", "https://previous.example") }
                assertThat(restored.forward(staleServer).statusCode.value()).isEqualTo(409)
                assertThat(restored.forward(MockHttpServletRequest("POST", "/api/v1/remote/flows/${java.util.UUID.randomUUID()}/runs")).statusCode.value()).isEqualTo(200)
                assertThat(started.single().serverUrl).isEqualTo(base)
                assertThat(started.single().login).isEqualTo("mock-user")
                assertThatThrownBy { restored.authenticatedJson("GET", "/api/v1/workspaces", expectedServer = base, expectedLogin = "someone-else") }
                    .hasMessageContaining("실행을 시작한 서버 계정")
                expire = true
                assertThat(restored.forward(req).statusCode.value()).isEqualTo(401)
                assertThat(restored.view().connected).isFalse()
                assertThat(requests).isEqualTo(3)
                assertThat(Files.exists(directory.resolve("db/flowlink.mv.db"))).isFalse()
            }
        } finally { server.stop(0) }
    }
}
