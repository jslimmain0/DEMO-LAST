package com.flowlink.execution.engine
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.config.ExecutionProperties
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.springframework.web.client.RestClient
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
class OneoffHttpTest {
    private val mapper = jacksonObjectMapper()
    private val json = JsonService(mapper)
    private val executor = HttpNodeExecutor(RestClient.create(), TokenResolver(json), json, ExecutionProperties(null))
    private fun node(url: String, headers: String = "") = mapper.readValue(mapper.writeValueAsString(mapOf("id" to "n", "type" to "http", "baseUrl" to url, "method" to "GET", "headersRaw" to true, "rawHeaders" to headers)), GraphNode::class.java)
    @Test fun `actual response preserves error status and explicit authorization without redirects`() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/target") { exchange ->
            assertEquals("Bearer target-token", exchange.requestHeaders.getFirst("Authorization"))
            assertNull(exchange.requestHeaders.getFirst("X-FlowLink-Local"))
            exchange.responseHeaders.add("X-Target", "yes")
            exchange.responseHeaders.add("Location", "/should-not-follow")
            val bytes = "blocked".toByteArray(); exchange.sendResponseHeaders(302, bytes.size.toLong()); exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val result = executor.executeOneoff(node("http://127.0.0.1:${server.address.port}/target", "Authorization: Bearer target-token"), 2)
            assertEquals(302, result.status); assertEquals("blocked", result.body); assertEquals("yes", result.headers["x-target"])
        } finally { server.stop(0) }
    }
    @Test fun `non http and userinfo and invalid timeout rejected before transport`() {
        assertThrows(IllegalArgumentException::class.java) { executor.executeOneoff(node("file:///private"), 2) }
        assertThrows(IllegalArgumentException::class.java) { executor.executeOneoff(node("http://user:pass@127.0.0.1"), 2) }
        assertThrows(IllegalArgumentException::class.java) { executor.executeOneoff(node("http://127.0.0.1"), 0) }
    }
}
