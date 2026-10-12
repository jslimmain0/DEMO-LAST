package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.agent.CentralResourceIdentity
import com.flowlink.common.error.BadRequestException
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import org.springframework.context.ApplicationEventPublisher
import org.springframework.mock.web.MockHttpServletRequest
import java.net.InetSocketAddress
import java.nio.file.Path

class DesktopCentralResourcesTest {
    @TempDir lateinit var directory: Path

    @Test fun `중앙 자원은 고정된 로그인 연결로만 조회하고 브라우저 프록시에서는 차단한다`() {
        val mapper = jacksonObjectMapper()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val calls = mutableListOf<com.fasterxml.jackson.databind.JsonNode>()
        server.createContext("/api/v1/") { exchange ->
            val result = when (exchange.requestURI.path) {
                "/api/v1/distribution" -> "{}"
                "/api/v1/auth/github/device/start" -> """{"sessionId":"mock-login"}"""
                "/api/v1/auth/github/device/poll" -> """{"status":"ready","token":"private-token","login":"tester"}"""
                "/api/v1/agent/resources" -> {
                    assertThat(exchange.requestHeaders.getFirst("Authorization")).isEqualTo("Bearer private-token")
                    assertThat(exchange.requestHeaders.getFirst("X-FlowLink-Device")).isNotBlank()
                    val body = mapper.readTree(exchange.requestBody); calls.add(body)
                    if (body.path("variables").asBoolean()) """{"vars":{"base":"central"},"secrets":{}}"""
                    else """{"vars":{},"secrets":{"selected":"private-value"}}"""
                }
                else -> error("Unexpected central resource request")
            }.toByteArray()
            exchange.sendResponseHeaders(200, result.size.toLong()); exchange.responseBody.use { it.write(result) }
        }
        server.start()
        try {
            DesktopSession(directory.toString(), 18218).use { session ->
                val connection = DesktopConnection(session, mapper, ApplicationEventPublisher {})
                val base = "http://127.0.0.1:${server.address.port}"
                connection.configure(base); connection.start(); connection.poll()
                val bridge = DesktopCentralResources(connection, mapper, DesktopProtocolClient(connection, mapper), DesktopTransformClient(connection, mapper))
                val identity = CentralResourceIdentity(base, "tester")
                assertThat(bridge.environment("dev", identity)).containsEntry("base", "central")
                assertThat(bridge.secrets("dev", setOf("selected"), identity)).containsOnlyKeys("selected")
                assertThat(calls.last().path("secretNames").map { it.asText() }).containsExactly("selected")
                assertThat(bridge.secrets("dev", emptySet(), identity)).isEmpty()
                assertThat(calls).hasSize(2)
                listOf("/agent/resources", "/agent;session=x/resources", "/agent/%72esources", "/agent/central-protocols/spec", "/agent/central-codecs/invoke", "/agent/central-transforms/invoke").forEach { path ->
                    assertThrows<BadRequestException> { connection.forward(MockHttpServletRequest("POST", "/api/v1/remote$path")) }
                }
                assertThrows<BadRequestException> { bridge.environment("dev", identity.copy(login = "other")) }
                connection.logout()
                assertThrows<BadRequestException> { bridge.environment("dev", identity) }
                assertThat(calls).hasSize(2)
            }
        } finally { server.stop(0) }
    }
}
