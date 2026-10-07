package com.flowlink.agent

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.config.ExecutionProperties
import com.flowlink.execution.engine.*
import com.flowlink.protocol.ProtocolResources
import com.flowlink.transform.TransformRegistry
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient
import java.util.UUID

class AgentHttpResponseParityTest {
    private fun execute(location: String, responseType: String, body: String, allowed: List<String>? = null, secret: String? = null): NodeResult {
        val json = JsonService(jacksonObjectMapper())
        val tokens = TokenResolver(json)
        val rest = RestClient.builder()
        val server = MockRestServiceServer.bindTo(rest).build()
        server.expect(requestTo("https://example.test")).andRespond(withSuccess(body, MediaType.TEXT_HTML))
        val resources = mock(AgentResources::class.java)
        `when`(resources.localRuntime).thenReturn(location == "local")
        `when`(resources.workspaceScope(if (location == "server") "public" else null)).thenReturn(null)
        `when`(resources.environmentExists("", null)).thenReturn(true)
        `when`(resources.environment("", null)).thenReturn(emptyMap())
        `when`(resources.secrets("", null)).thenReturn(secret?.let { mapOf("TOKEN" to it) }.orEmpty())
        val transforms = mock(TransformRegistry::class.java)
        val engine = FlowExecutor(tokens, ExpressionEvaluator(tokens), HttpNodeExecutor(rest.build(), tokens, json, ExecutionProperties(null)),
            json, transforms, TcpNodeExecutor(tokens, mock(ProtocolResources::class.java)))
        val executor = AgentNodeExecutor(engine, resources, json, tokens, transforms)
        val node = json.mapper().readValue("""{"id":"http","type":"http","executionAgent":"$location","baseUrl":"https://example.test","respType":"$responseType","outputs":[{"key":"data"},{"key":"id"}]}""", GraphNode::class.java).copy(agentOutputs = allowed)
        val run = AgentRunOptions(UUID.randomUUID(), "device", if (location == "server") "local" else "server", "dev", "public", "", agentEnvironments = mapOf("local" to "", "server:public" to ""))
        val request = AgentRequestBuilder(json, tokens).build(node, listOf(node), ExecutionContext(), run, 0)
        val result = executor.execute(request).result
        server.verify()
        return result
    }

    @Test fun `HTML and text body survive both delegation directions with default output fields`() {
        val html = "<!doctype html><html><title>테스트</title><body>응답 본문</body></html>"
        for (type in listOf("json", "text")) {
            val local = execute("local", type, html)
            val remote = execute("server", type, html)
            assertTrue(local.ok); assertTrue(remote.ok)
            assertEquals(200, remote.httpStatus)
            assertEquals(html, remote.responseText)
            assertEquals(local.responseText, remote.responseText)
            assertEquals(local.value, remote.value)
            assertEquals(html, (remote.value as Map<*, *>)["body"])
            assertEquals(200, (remote.value as Map<*, *>)["httpStatus"])
        }
    }

    @Test fun `explicit output restrictions still exclude body and undeclared JSON fields`() {
        for (location in listOf("local", "server")) {
            val limited = execute(location, "text", "private body", listOf("httpStatus"))
            assertFalse(limited.responseText.orEmpty().contains("private body"))
            assertEquals(mapOf("httpStatus" to 200), limited.value)
            val structured = execute(location, "json", """{"data":"selected","private":"hidden"}""")
            assertFalse(structured.responseText.orEmpty().contains("hidden"))
            assertEquals("selected", (structured.value as Map<*, *>)["data"])
        }
    }

    @Test fun `delegated response display uses masked body instead of raw secret`() {
        for (location in listOf("local", "server")) {
            val result = execute(location, "text", "hello sensitive-token goodbye", secret = "sensitive-token")
            assertTrue(result.ok)
            assertFalse(result.responseText.orEmpty().contains("sensitive-token"))
            assertTrue(result.responseText.orEmpty().startsWith("hello "))
            assertEquals((result.value as Map<*, *>)["body"], result.responseText)
        }
    }
}
