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
    private fun valid(name: String, args: Map<String, Any>): Boolean {
        val schema = mapper.convertValue(catalog.getValue(name).path("inputSchema"), object : TypeReference<Map<String, Any>>() {})
        return JsonSchemaValidator.getDefault().validate(schema, args).valid()
    }

    @Test fun `legacy catalogue remains complete and scopes are distinct`() {
        assertEquals(58, catalog.size)
        assertEquals(setOf(
            "flowlink_status", "flowlink_update_status", "flowlink_guide", "workspace_list", "workspace_get", "workspace_export", "workspace_import",
            "folder_list", "folder_create", "folder_update", "folder_delete", "protocol_list", "protocol_get", "protocol_upsert", "protocol_preview", "protocol_delete",
            "mock_list", "mock_get", "mock_upsert", "mock_send", "mock_log", "mock_delete", "mock_versions", "mock_version", "mock_state", "mock_reset", "mock_clear_log", "mock_usages", "codec_try",
            "flow_list", "flow_get", "flow_upsert", "flow_update", "flow_delete", "flow_versions", "flow_version", "flow_run", "execution_get", "execution_list", "execution_resume", "execution_rerun", "node_run", "suite_run",
            "env_list", "env_put", "env_rename", "env_delete", "flow_run_input", "secret_list", "plugin_list", "transform_preview", "plugin_script_list", "plugin_script_get", "plugin_script_try", "plugin_script_upsert", "plugin_script_submit", "plugin_script_wait", "http_request"
        ), catalog.keys)
        val schema = catalog.getValue("http_request").path("inputSchema")
        assertEquals(listOf("local", "server"), schema.path("properties").path("target").path("enum").map { it.asText() })
        assertEquals(listOf("local", "server"), schema.path("properties").path("executionAgent").path("enum").map { it.asText() })
        assertTrue(catalog.getValue("execution_resume").path("description").asText().contains("가장하지"))
    }

    @Test fun `schema validator preserves required arguments bounds and JSON string input`() {
        assertFalse(valid("flow_upsert", mapOf("name" to "empty")))
        assertTrue(valid("flow_upsert", mapOf("name" to "flow", "graph" to "{\"nodes\":[],\"edges\":[]}")))
        assertTrue(valid("flow_upsert", mapOf("graph" to emptyMap<String, Any>(), "layout" to "compact-tree")))
        assertTrue(valid("flow_upsert", mapOf("graph" to emptyMap<String, Any>(), "layout" to "preserve")))
        assertFalse(valid("flow_upsert", mapOf("graph" to emptyMap<String, Any>(), "layout" to "other")))
        assertFalse(valid("http_request", mapOf("url" to "/mock/example", "timeoutSec" to 121)))
        assertFalse(valid("http_request", mapOf("url" to "/mock/example", "executionAgent" to "browser")))
        assertFalse(valid("plugin_script_submit", mapOf("id" to "a", "action" to "approve")))
        assertTrue(valid("plugin_script_submit", mapOf("id" to "a", "action" to "withdraw")))
    }

    @Test fun `TCP preview directions are optional and validate explicit wire and codec choices`() {
        val required = catalog.getValue("protocol_preview").path("inputSchema").path("required").map { it.asText() }
        assertEquals(listOf("key"), required)
        assertTrue(valid("protocol_preview", mapOf("key" to "request")))
        for (field in listOf("direction", "frameDirection")) {
            assertEquals(listOf("send", "recv"), catalog.getValue("protocol_preview").path("inputSchema").path("properties").path(field).path("enum").map { it.asText() })
            assertTrue(valid("protocol_preview", mapOf("key" to "custom", field to "recv")))
            assertFalse(valid("protocol_preview", mapOf("key" to "custom", field to "other")))
        }
        assertTrue(catalog.getValue("protocol_upsert").path("description").asText().contains("responseFraming"))
        assertTrue(catalog.getValue("mock_send").path("description").asText().contains("호출마다 연결을 종료"))
    }

    @Test fun `common catalogue removes advertised location but accepts legacy extras`() {
        val central = catalog.keys.filter { it.startsWith("protocol_") || it.startsWith("plugin_") || it in setOf("secret_list", "transform_preview") }
        for (name in central) {
            val properties = catalog.getValue(name).path("inputSchema").path("properties")
            assertFalse(properties.has("target"), name)
            assertFalse(properties.has("workspace"), name)
            assertTrue(catalog.getValue(name).path("description").asText().contains("public"), name)
        }
        assertTrue(valid("protocol_list", mapOf("target" to "local", "workspace" to "legacy-team")))
        assertTrue(valid("secret_list", mapOf("target" to "local", "workspace" to "legacy-team")))
    }

    @Test fun `environment tools expose independent local and server sources`() {
        for (name in listOf("env_list", "env_put", "env_rename", "env_delete")) {
            val properties = catalog.getValue(name).path("inputSchema").path("properties")
            assertEquals(listOf("local", "server"), properties.path("target").path("enum").map { it.asText() }, name)
            assertEquals("server", properties.path("target").path("default").asText(), name)
            assertFalse(properties.has("workspace"), name)
        }
        val environment = mapOf("name" to "개발", "vars" to mapOf("BASE_URL" to "https://example.invalid"))
        assertTrue(valid("env_put", environment + ("target" to "local")))
        assertTrue(valid("env_put", environment + ("target" to "server")))
        assertFalse(valid("env_put", environment + ("target" to "browser")))
    }

    @Test fun `execution source is optional and rerun preserves original options`() {
        val requests = mapOf(
            "flow_run" to mapOf("id" to "flow"),
            "node_run" to mapOf("flowId" to "flow", "nodeId" to "node"),
            "suite_run" to mapOf("flowIds" to listOf("flow"))
        )
        for ((name, args) in requests) {
            val properties = catalog.getValue(name).path("inputSchema").path("properties")
            assertEquals(listOf("local", "server"), properties.path("envSource").path("enum").map { it.asText() }, name)
            assertFalse(properties.path("envSource").has("default"), name)
            assertFalse(catalog.getValue(name).path("inputSchema").path("required").any { it.asText() == "envSource" }, name)
            for (internal in listOf("env", "resourceWorkspaceId", "resourceIdentity")) assertFalse(properties.has(internal), "$name $internal")
            assertTrue(valid(name, args))
            assertTrue(valid(name, args + mapOf("envSource" to "local", "envName" to "개발", "input" to mapOf("orderId" to "test"))))
            assertTrue(valid(name, args + mapOf("envSource" to "server", "envName" to "개발")))
            assertFalse(valid(name, args + ("envSource" to "merged")))
        }
        val rerun = catalog.getValue("execution_rerun")
        assertFalse(rerun.path("inputSchema").path("properties").has("envSource"))
        assertTrue(rerun.path("description").asText().contains("복원"))
        assertTrue(McpConfiguration.RESOURCE_GUIDE.contains("기존 metadata 없는 자료·재실행"))
    }

    @Test fun `new resource metadata remains optional and legacy descriptions preserve scope`() {
        val flow = mapOf("nodes" to emptyList<Any>(), "edges" to emptyList<Any>())
        assertTrue(valid("flow_upsert", mapOf("id" to "legacy-flow", "graph" to flow)))
        assertTrue(valid("flow_upsert", mapOf("graph" to (flow + ("resourceWorkspaceId" to "public")))))
        assertFalse(valid("flow_upsert", mapOf("graph" to (flow + ("resourceWorkspaceId" to "private-team")))))
        val mock = mapOf("name" to "Mock", "slug" to "mock", "type" to "HTTP")
        assertTrue(valid("mock_upsert", mock + ("spec" to emptyMap<String, Any>())))
        assertTrue(valid("mock_upsert", mock + ("spec" to mapOf("resourceWorkspaceId" to "public", "envSource" to "server"))))
        assertFalse(valid("mock_upsert", mock + ("spec" to mapOf("envSource" to "merged"))))
        for (name in listOf("flow_upsert", "mock_upsert")) assertTrue(catalog.getValue(name).path("description").asText().contains("기존 metadata 없는"), name)
        val description = catalog.getValue("mock_list").path("description").asText()
        for (field in listOf("mocks", "sources", "target", "workspaceId", "available", "httpStatus")) assertTrue(description.contains(field), field)
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
