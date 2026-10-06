package com.flowlink.execution.engine

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class EndpointResolverTest {
    private val mapper = jacksonObjectMapper()
    private val tokens = TokenResolver(JsonService(mapper))
    private val node = mapper.readValue("""{"id":"n","type":"http","baseUrl":"{{PAYMENT@env}}"}""", GraphNode::class.java)
    private fun ctx(value: String) = ExecutionContext().apply { putOutput("env", mapOf("PAYMENT" to value)); putSeed("secret", mapOf("TOKEN" to "secret-value")) }
    @Test fun `same graph resolves each executing environment`() {
        assertEquals("http://192.0.2.1", EndpointResolver.diagnostics(node, ctx("http://192.0.2.1"), "dev", tokens)["resolvedTarget"])
        assertEquals("https://payment.internal", EndpointResolver.diagnostics(node, ctx("https://payment.internal"), "dev", tokens)["resolvedTarget"])
    }
    @Test fun `missing resource in headers and malformed address fail`() {
        for (value in listOf("", "payment.internal", "file:///tmp/payment", "http://host:70000"))
            assertThrows(IllegalArgumentException::class.java) { EndpointResolver.diagnostics(node, ctx(value), "dev", tokens) }
        assertThrows(IllegalArgumentException::class.java) { EndpointResolver.diagnostics(node, ExecutionContext(), "dev", tokens) }
        val header = node.copy(rawHeaders = "Authorization: {{missing@secret}}")
        assertThrows(IllegalArgumentException::class.java) { tokens.requireResourceReferences(header, ctx("http://host")) }
    }
    @Test fun `port reference takes precedence and cannot silently fall back`() {
        val tcp = node.copy(type = "tcp", tcpPort = 1234, tcpPortEnvKey = "PAYMENT")
        assertEquals(1521, EndpointResolver.port(tcp, ctx("1521")))
        for (value in listOf("", "abc", "0", "65536"))
            assertThrows(IllegalArgumentException::class.java) { EndpointResolver.port(tcp, ctx(value)) }
    }
    @Test fun `diagnostics omit URL credentials query and secret in path`() {
        val result = EndpointResolver.diagnostics(node, ctx("https://user:password@payment.internal/secret-value?token=secret"), "dev", tokens)
        assertFalse(result.toString().contains("password"))
        assertFalse(result.toString().contains("token="))
        assertFalse(result.toString().contains("secret-value"))
    }
    @Test fun `upstream address remains deferred and browser requester is truthful`() {
        val result = EndpointResolver.diagnostics(node.copy(baseUrl = "{{url@previous}}", reqMode = "client"), ctx("http://host"), "dev", tokens)
        assertNull(result["resolvedTarget"])
        assertEquals("upstream-binding", result["source"])
        assertEquals("browser", result["requester"])
    }

    @Test fun `actual HTTP builder resolves environment and rejects missing secret before sending`() {
        val executor = HttpNodeExecutor(org.springframework.web.client.RestClient.create(), tokens, JsonService(mapper), com.flowlink.execution.config.ExecutionProperties(null))
        assertEquals("http://192.0.2.1", executor.build(node, ctx("http://192.0.2.1")).url)
        assertEquals("https://payment.internal", executor.build(node, ctx("https://payment.internal")).url)
        assertThrows(IllegalArgumentException::class.java) { executor.build(node.copy(rawHeaders = "Authorization: {{missing@secret}}", headersRaw = true), ctx("http://host")) }
        assertThrows(IllegalArgumentException::class.java) { tokens.requireResourceReferences(node.copy(rawBody = "{{PAYMENT@req:env}}"), ctx("http://host")) }
    }

    @Test fun `form owner diagnostics inspect active references and ignore unused port and raw body`() {
        val form = node.copy(type = "form", formAction = "{{PAYMENT@env}}", jsonRaw = false, rawBody = "{{missing@secret}}", tcpPortEnvKey = "UNUSED")
        val result = EndpointResolver.diagnostics(form, ctx("https://payment.internal/pay"), "dev", tokens)
        assertEquals("https://payment.internal/pay", result["resolvedTarget"])
        assertEquals("owner-environment", result["source"])
        assertEquals("browser", result["requester"])
        assertThrows(IllegalArgumentException::class.java) { EndpointResolver.diagnostics(form.copy(formAction = "{{missing@env}}"), ctx("http://host"), "dev", tokens) }
        val input = form.copy(type = "input", waitMsg = "{{PAYMENT@env}}")
        assertNull(EndpointResolver.diagnostics(input, ctx("http://host"), "dev", tokens)["resolvedTarget"])
    }
}
