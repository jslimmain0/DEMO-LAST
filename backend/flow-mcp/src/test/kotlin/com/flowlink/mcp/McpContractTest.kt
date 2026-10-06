package com.flowlink.mcp

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.modelcontextprotocol.json.schema.JsonSchemaValidator
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.mock.web.MockHttpServletRequest

/** Pure metadata / routing decisions only. Does not create a transport or invoke a tool. */
class McpContractTest {
    private val mapper = jacksonObjectMapper()
    private val catalog = javaClass.getResourceAsStream("/flowlink-tools.json")!!.use { mapper.readTree(it) }.associateBy { it.path("name").asText() }

    @Test fun `legacy catalogue remains complete and scopes are distinct`() {
        assertEquals(58, catalog.size)
        val schema = catalog.getValue("http_request").path("inputSchema")
        assertEquals(listOf("local", "server"), schema.path("properties").path("target").path("enum").map { it.asText() })
        assertEquals(listOf("local", "server"), schema.path("properties").path("executionAgent").path("enum").map { it.asText() })
        assertTrue(catalog.getValue("execution_resume").path("description").asText().contains("가장하지"))
    }

    @Test fun `schema validator preserves required arguments bounds and JSON string input`() {
        fun valid(name: String, args: Map<String, Any>): Boolean {
            val schema = mapper.convertValue(catalog.getValue(name).path("inputSchema"), object : TypeReference<Map<String, Any>>() {})
            return JsonSchemaValidator.getDefault().validate(schema, args).valid()
        }
        assertFalse(valid("flow_upsert", mapOf("name" to "empty")))
        assertTrue(valid("flow_upsert", mapOf("name" to "flow", "graph" to "{\"nodes\":[],\"edges\":[]}")))
        assertFalse(valid("http_request", mapOf("url" to "/mock/example", "timeoutSec" to 121)))
        assertFalse(valid("http_request", mapOf("url" to "/mock/example", "executionAgent" to "browser")))
        assertFalse(valid("plugin_script_submit", mapOf("id" to "a", "action" to "approve")))
        assertTrue(valid("plugin_script_submit", mapOf("id" to "a", "action" to "withdraw")))
    }

    @Test fun `unknown agent and human waiting never automatically continue polling`() {
        assertFalse(McpTools.isPending(mapper.readTree("""{"status":"WAITING","pendingAgent":{"status":"UNKNOWN"}}""")))
        assertFalse(McpTools.isPending(mapper.readTree("""{"status":"WAITING","pendingInput":{"nodeId":"input"}}""")))
        assertTrue(McpTools.isPending(mapper.readTree("""{"status":"WAITING","pendingAgent":{"status":"RUNNING"}}""")))
    }

    @Test fun `internal destination ignores hostile forwarded headers and bearer stays per request`() {
        val first = MockHttpServletRequest().apply { localPort = 18080; addHeader("Host", "attacker.invalid"); addHeader("X-Forwarded-Host", "attacker.invalid"); addHeader("Authorization", "Bearer first-user") }
        val second = MockHttpServletRequest().apply { localPort = 18080 }
        assertEquals("http://127.0.0.1:18080", McpConfiguration.invocation(first).origin)
        assertNull(McpConfiguration.invocation(first).authorization) // Raw app bearer is not forwarded.
        first.setAttribute("flowlink.mcp.managementAuthorization", "Bearer verified-internal")
        assertEquals("Bearer verified-internal", McpConfiguration.invocation(first).authorization)
        assertNull(McpConfiguration.invocation(second).authorization)
        second.contextPath = "/flowlink"
        assertEquals("http://127.0.0.1:18080/flowlink", McpConfiguration.invocation(second).origin)
        assertEquals("a%2Fb%20c", McpRestClient.segment("a/b c"))
    }

    @Test fun `origin parsing rejects opaque credentials paths and lookalike hosts`() {
        assertEquals("https://company.example:443", McpConfiguration.normalizedOrigin("https://company.example"))
        assertNull(McpConfiguration.normalizedOrigin("null"))
        assertNull(McpConfiguration.normalizedOrigin("https://company.example@attacker.example"))
        assertNull(McpConfiguration.normalizedOrigin("https://company.example/mcp"))
        assertNotEquals(McpConfiguration.normalizedOrigin("https://company.example"), McpConfiguration.normalizedOrigin("https://company.example.attacker.example"))
    }

    @Test fun `forwarded HTTPS does not change the internal connector scheme`() {
        val request = MockHttpServletRequest().apply {
            localPort = 18080
            contextPath = "/flowlink"
            scheme = "https"
            isSecure = true
            addHeader("X-Forwarded-Proto", "https")
            addHeader("X-Forwarded-Port", "443")
        }
        assertEquals("http://127.0.0.1:18080/flowlink", McpConfiguration.invocation(request).origin)
        assertEquals("http://127.0.0.1:18080/flowlink", McpConfiguration.invocation(request, false).origin)
        assertEquals("https://127.0.0.1:18080/flowlink", McpConfiguration.invocation(request, true).origin)
    }
}
