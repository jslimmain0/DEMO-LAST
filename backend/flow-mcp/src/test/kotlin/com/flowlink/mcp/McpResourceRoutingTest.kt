package com.flowlink.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Answers
import org.mockito.Mockito.mock

/** Real tool adapter decisions with an isolated fake REST peer; no credentials, DB or MCP registration. */
class McpResourceRoutingTest {
    private val mapper = jacksonObjectMapper()
    private data class Request(val context: McpInvocation, val method: String, val path: String, val body: JsonNode?, val pc: Boolean, val remote: Boolean)
    private val requests = mutableListOf<Request>()
    private var graph: JsonNode = json("""{"resourceWorkspaceId":"public","nodes":[{"id":"t","type":"transform","executionAgent":"local"}],"edges":[]}""")
    private var savedSpec: JsonNode = json("""{"routes":[]}""")
    private var exists = true
    private var pcError: RuntimeException? = null
    private var serverError: RuntimeException? = null
    private var sessionError: RuntimeException? = null
    private var environments = true
    private var v2Protocol = false
    private val server = McpInvocation("http://127.0.0.1:18080", "Bearer synthetic", "server", "team")
    private val local = server.copy(target = "local", workspaceId = "pc")
    private val rest = mock(McpRestClient::class.java) { call ->
        if (call.method.name != "api") Answers.RETURNS_DEFAULTS.answer(call) else {
            val request = Request(call.getArgument(0), call.getArgument(1), call.getArgument(2), call.getArgument(3), call.getArgument(5), call.getArgument(6))
            requests += request
            if (request.context.target == "local") pcError?.let { throw it } else serverError?.let { throw it }
            if (request.path.contains("/tcp-sessions")) sessionError?.let { throw it }
            when {
                request.path.endsWith("/validate") -> json("""{"valid":true,"schemaVersion":2,"requiredCapabilities":["transactionFraming"]}""")
                request.path == "/mock-servers/upsert" -> json("""{"id":"mock"}""")
                request.path == "/workspaces" -> json(if (request.context.target == "local") """[{"id":"pc","kind":"PERSONAL"}]""" else """[{"id":"public","kind":"PUBLIC"},{"id":"team","kind":"TEAM"}]""")
                request.path == "/environments" -> json(if (!environments) "[]" else if (request.context.target == "local") """[{"name":"same","vars":{"ORIGIN":"PC","PC_ONLY":"yes"}}]""" else """[{"name":"same","vars":{"ORIGIN":"SERVER","SERVER_ONLY":"yes"}}]""")
                request.path == "/protocols" -> json(if (v2Protocol) """[{"id":"v2","name":"shared","schemaVersion":2,"requiredCapabilities":["transactionFraming"]}]""" else """[{"id":"public-protocol","name":"shared"}]""")
                request.path == "/flows" && request.method == "POST" -> json("""{"id":"flow"}""")
                request.path == "/flows/flow" -> mapper.createObjectNode().apply { put("id", "flow"); set<JsonNode>("graph", graph) }
                request.path == "/flows/flow/versions" && request.method == "GET" -> json("""[{"id":"original-version","versionNo":1}]""")
                request.path == "/flows/flow/versions/1" -> graph
                request.path == "/executions/original" -> json("""{"id":"original","flowId":"flow","flowVersionId":"original-version","status":"SUCCEEDED"}""")
                request.path.endsWith("/runs") || request.path.endsWith("/rerun") -> json("""{"id":"new-run","flowId":"flow","status":"SUCCEEDED","nodes":[]}""")
                request.path == "/mock-servers" && request.method == "GET" -> json(if (exists) """[{"id":"mock","slug":"same"}]""" else "[]")
                request.path == "/mock-servers" && request.method == "POST" -> json("""{"id":"mock"}""")
                request.path == "/mock-servers/mock" -> mapper.createObjectNode().apply { put("id", "mock"); set<JsonNode>("spec", savedSpec) }
                request.path == "/mock-servers/fleet" -> json(if (request.context.target == "local") """{"servers":[{"id":"same-id","workspaceId":"pc"}]}""" else """{"servers":[{"id":"same-id","workspaceId":"public"}]}""")
                request.path == "/mock-servers/mock/tcp-sessions" -> json("""[{"id":"7a9cbbd6-38ce-494e-8a2b-04c647a6e478","state":"waiting","remainingMs":25000,"receivedMessages":2}]""")
                request.path.endsWith("/extend") -> json("""{"id":"7a9cbbd6-38ce-494e-8a2b-04c647a6e478","state":"waiting","remainingMs":85000,"receivedMessages":2}""")
                else -> mapper.createObjectNode()
            }
        }
    }
    private val tools = McpTools(mapper, rest)
    private fun json(value: String): JsonNode = mapper.readTree(value)
    private fun args(value: String = "{}") = json(value) as ObjectNode

    @Test fun `authoring guide separates preview test save and approval without performing them`() {
        for (topic in listOf("flow", "protocol", "mock", "plugin")) {
            requests.clear()
            val guide = tools.invoke("flowlink_guide", args("""{"topic":"$topic"}"""), server) as String
            for (action in listOf("연결 설정", "연결 세션", "protocol_preview", "flow_upsert", "node_run", "execution_get", "plugin_script_try", "plugin_script_upsert", "plugin_script_submit")) {
                assertTrue(guide.contains(action), "$topic $action")
            }
            assertEquals(listOf("GET"), requests.map { it.method })
            assertEquals("/schemas", requests.single().path)
            assertEquals("server", requests.single().context.target)
        }
    }

    @Test fun `omitted TCP execution agent checks owning PC while explicit server checks server before transmission`() {
        v2Protocol = true
        graph = json("""{"resourceWorkspaceId":"public","nodes":[{"id":"tcp","type":"tcp","protocolId":"v2"}],"edges":[]}""")
        val error = assertThrows(IllegalArgumentException::class.java) { tools.invoke("flow_run", args("""{"id":"flow"}"""), local) }
        assertTrue(error.message!!.contains("CAPABILITY_UNKNOWN"))
        assertEquals("local", requests.single { it.path == "/runtime/capabilities" }.context.target)
        assertFalse(requests.any { it.method == "POST" })
        requests.clear()
        (graph.path("nodes").path(0) as ObjectNode).put("executionAgent", "server")
        val serverError = assertThrows(IllegalArgumentException::class.java) { tools.invoke("flow_run", args("""{"id":"flow"}"""), local) }
        assertTrue(serverError.message!!.contains("CAPABILITY_UNKNOWN"))
        assertEquals("server", requests.single { it.path == "/runtime/capabilities" }.context.target)
        assertFalse(requests.any { it.method == "POST" })
    }

    @Test fun `central tool scopes ignore legacy PC team selectors without a PC lookup`() {
        for (name in listOf("protocol_list", "protocol_upsert", "secret_list", "plugin_list", "plugin_script_try", "transform_preview")) {
            val scope = tools.scopeFor(name, args("""{"target":"local","workspace":"old-private"}"""), server)
            assertEquals("server", scope.target); assertEquals("public", scope.workspaceId)
        }
        assertTrue(requests.isEmpty())
        assertEquals("public", tools.scopeFor("env_list", args("""{"target":"server","workspace":"team"}"""), server).workspaceId)
    }

    @Test fun `TCP spec options and explicit preview directions reach REST without adding legacy defaults`() {
        val spec = json("""{"framing":{"mode":"fixed","fixedLength":14},"responseFraming":{"mode":"fixed","fixedLength":8},
            "transport":{"connection":"execution","idleTimeoutMs":30000,"requestAckHex":"06","responseAckHex":"06"}}""")
        val scope = tools.scopeFor("protocol_upsert", args(), server)
        tools.invoke("protocol_upsert", args("""{"name":"new"}""").apply { set<JsonNode>("spec", spec) }, scope)
        assertEquals(spec, requests.last().body!!.path("spec"))
        assertEquals("public", requests.last().context.workspaceId)
        requests.clear()
        val preview = args("""{"key":"custom","values":{"result":"A001"},"direction":"send","frameDirection":"recv","environment":"same"}""")
            .apply { set<JsonNode>("spec", spec) }
        tools.invoke("protocol_preview", preview, scope)
        val body = requests.single().body!!
        assertEquals(spec, body.path("spec")); assertEquals("send", body.path("direction").asText())
        assertEquals("recv", body.path("frameDirection").asText()); assertEquals("same", body.path("environment").asText())
        requests.clear(); preview.remove(listOf("direction", "frameDirection", "values"))
        tools.invoke("protocol_preview", preview, scope)
        assertFalse(requests.single().body!!.has("direction")); assertFalse(requests.single().body!!.has("frameDirection"))
        assertEquals(mapper.createObjectNode(), requests.single().body!!.path("values"))
    }

    @Test fun `same named PC source reaches server proxy with exact snapshot and only node metadata`() {
        tools.invoke("node_run", args("""{"flowId":"flow","nodeId":"t","envName":"same","envSource":"local","input":{"order":7},"upstream":{"before":{"amount":17}}}"""), server)
        val run = requests.single { it.path.endsWith("/runs") }
        assertTrue(run.pc); assertTrue(run.remote)
        assertEquals("public", run.body!!.path("resourceWorkspaceId").asText())
        assertEquals("local", run.body.path("envSource").asText())
        assertEquals(json("""{"ORIGIN":"PC","PC_ONLY":"yes"}"""), run.body.path("env"))
        assertEquals("t", run.body.path("onlyNodeId").asText())
        assertEquals(7, run.body.path("input").path("order").asInt())
        assertEquals(17, run.body.path("upstream").path("before").path("amount").asInt())
        assertFalse(run.body.has("resourceIdentity")); assertFalse(run.body.has("agentDeviceId")); assertFalse(run.body.has("clientExecutionId"))
    }

    @Test fun `TCP session list resolves Mock slug in selected PC or server workspace`() {
        for (scope in listOf(local, server)) {
            requests.clear()
            val result = mapper.valueToTree<JsonNode>(tools.invoke("mock_tcp_sessions", args("""{"slug":"same"}"""), scope))
            assertEquals("waiting", result.path(0).path("state").asText())
            assertEquals(2, result.path(0).path("receivedMessages").asInt())
            assertEquals(listOf("/mock-servers", "/mock-servers/mock/tcp-sessions"), requests.map { it.path })
            assertTrue(requests.all { it.method == "GET" && it.context == scope && it.body == null })
        }
        assertEquals("pc", tools.scopeFor("mock_tcp_sessions", args("""{"target":"local"}"""), server).workspaceId)
        assertEquals("team", tools.scopeFor("mock_tcp_sessions", args("""{"workspace":"team"}"""), server).workspaceId)
    }

    @Test fun `TCP session extension forwards only selected ID and duration without reconnecting`() {
        val id = "7a9cbbd6-38ce-494e-8a2b-04c647a6e478"
        val input = args("""{"slug":"same","action":"extend","sessionId":"$id"}""")
        for (duration in listOf<Long?>(null, 1000, 3600000)) {
            requests.clear()
            if (duration == null) input.remove("extendMs") else input.put("extendMs", duration)
            val result = mapper.valueToTree<JsonNode>(tools.invoke("mock_tcp_sessions", input, local))
            assertEquals(id, result.path("id").asText())
            assertEquals(85000, result.path("remainingMs").asInt())
            assertEquals(listOf("GET", "POST"), requests.map { it.method })
            assertEquals("/mock-servers/mock/tcp-sessions/$id/extend", requests.last().path)
            assertEquals(1, requests.last().body!!.size())
            assertEquals(duration ?: 60000L, requests.last().body!!.path("extendMs").asLong())
            assertTrue(requests.all { it.context == local })
        }
    }

    @Test fun `TCP session invalid actions IDs and extension bounds reject before REST`() {
        val base = """"slug":"same","action":"extend","sessionId":"7a9cbbd6-38ce-494e-8a2b-04c647a6e478""""
        val invalid = listOf(
            """{"slug":"same","action":"close"}""", """{"slug":"same","action":"extend"}""",
            """{"slug":"same","action":"extend","sessionId":"../other"}""",
            "{$base,\"extendMs\":999}", "{$base,\"extendMs\":3600001}",
            "{$base,\"extendMs\":1000.5}", "{$base,\"extendMs\":\"60000\"}", "{$base,\"extendMs\":9223372036854775808}"
        )
        for (input in invalid) {
            requests.clear()
            assertThrows(IllegalArgumentException::class.java) { tools.invoke("mock_tcp_sessions", args(input), server) }
            assertTrue(requests.isEmpty(), input)
        }
    }

    @Test fun `TCP session permission expired or processing errors propagate without fallback or retry`() {
        val input = args("""{"slug":"same","action":"extend","sessionId":"7a9cbbd6-38ce-494e-8a2b-04c647a6e478"}""")
        for (status in listOf(400, 403, 404)) {
            requests.clear(); sessionError = McpApiException(status, "synthetic session error")
            val failure = assertThrows(McpApiException::class.java) { tools.invoke("mock_tcp_sessions", input, local) }
            assertEquals(status, failure.status)
            assertEquals(listOf("GET", "POST"), requests.map { it.method })
            assertTrue(requests.all { it.context.target == "local" })
        }
        sessionError = null; exists = false; requests.clear()
        assertThrows(IllegalArgumentException::class.java) { tools.invoke("mock_tcp_sessions", input, server) }
        assertEquals(listOf("GET"), requests.map { it.method })
    }

    @Test fun `central protocol deletion rejects private IDs before DELETE and accepts listed public IDs`() {
        val privateArgs = args("""{"target":"local","workspace":"team","id":"private-protocol"}""")
        val scope = tools.scopeFor("protocol_delete", privateArgs, server)
        assertThrows(IllegalArgumentException::class.java) { tools.invoke("protocol_delete", privateArgs, scope) }
        assertFalse(requests.any { it.method == "DELETE" })
        assertEquals("public", requests.single().context.workspaceId)
        assertEquals("server", requests.single().context.target)
        requests.clear()
        tools.invoke("protocol_delete", args("""{"id":"public-protocol"}"""), scope)
        assertEquals(listOf("GET", "DELETE"), requests.map { it.method })
        assertEquals("/protocols/public-protocol", requests.last().path)
    }

    @Test fun `public server source ignores legacy local transform hints and empty env remains explicit`() {
        tools.invoke("flow_run", args("""{"id":"flow","envName":"same"}"""), server)
        var run = requests.last { it.path.endsWith("/runs") }
        assertFalse(run.pc); assertEquals("SERVER", run.body!!.path("env").path("ORIGIN").asText())
        assertEquals("public", requests.single { it.path == "/environments" }.context.workspaceId)
        requests.clear(); tools.invoke("flow_run", args("""{"id":"flow"}"""), server)
        run = requests.last { it.path.endsWith("/runs") }
        assertEquals(mapper.createObjectNode(), run.body!!.path("env"))
        assertEquals("server", run.body!!.path("envSource").asText())
    }

    @Test fun `missing selected environment rejects before starting and legacy runs retain original request`() {
        environments = false
        assertThrows(IllegalArgumentException::class.java) { tools.invoke("flow_run", args("""{"id":"flow","envName":"missing"}"""), local) }
        assertFalse(requests.any { it.path.endsWith("/runs") })
        graph = json("""{"nodes":[{"id":"set","type":"set","executionAgent":"local"}],"edges":[]}""")
        requests.clear(); tools.invoke("flow_run", args("""{"id":"flow","envName":"legacy-team","input":{"order":8}}"""), server)
        val run = requests.single { it.path.endsWith("/runs") }
        assertFalse(run.pc); assertFalse(run.body!!.has("envSource")); assertFalse(run.body.has("env")); assertFalse(run.body.has("resourceWorkspaceId"))
        assertEquals("legacy-team", run.body.path("envName").asText()); assertFalse(requests.any { it.path == "/environments" })
    }

    @Test fun `save defaults apply only to new graphs and original raw private refs remain unchanged`() {
        val raw = args("""{"id":"flow","graph":{"nodes":[{"id":"tcp","type":"tcp","protocolId":"private-old","agentWorkspaceId":"old-space"}],"edges":[]},"layout":"preserve"}""")
        graph = json("""{"nodes":[],"edges":[]}""")
        tools.invoke("flow_upsert", raw, local)
        var saved = requests.last { it.path == "/flows/flow/versions" }.body!!.path("graph")
        assertFalse(saved.has("resourceWorkspaceId")); assertEquals("private-old", saved.path("nodes").path(0).path("protocolId").asText())
        assertFalse(raw.path("graph").has("resourceWorkspaceId"))
        graph = json("""{"resourceWorkspaceId":"public","nodes":[],"edges":[]}""")
        requests.clear(); tools.invoke("flow_upsert", raw, local)
        saved = requests.last { it.path == "/flows/flow/versions" }.body!!.path("graph")
        assertEquals("public", saved.path("resourceWorkspaceId").asText())
        requests.clear(); val created = args("""{"name":"new","graph":{"nodes":[],"edges":[]}}""")
        tools.invoke("flow_upsert", created, local)
        assertEquals("public", requests.last { it.path == "/flows/flow/versions" }.body!!.path("graph").path("resourceWorkspaceId").asText())
    }

    @Test fun `Mock editing preserves legacy private spec while new and explicit source use public`() {
        tools.invoke("mock_upsert", args("""{"slug":"same","spec":{"tcp":{"protocolId":"private-old"}}}"""), local)
        var saved = requests.last { it.path == "/mock-servers/upsert" }.body!!.path("spec")
        assertFalse(saved.has("resourceWorkspaceId")); assertFalse(saved.has("envSource")); assertEquals("private-old", saved.path("tcp").path("protocolId").asText())
        savedSpec = json("""{"resourceWorkspaceId":"public","envSource":"server","resourceIdentity":{"serverUrl":"https://actual.example","login":"alice"},"routes":[]}""")
        requests.clear(); tools.invoke("mock_upsert", args("""{"slug":"same","spec":{"routes":[]}}"""), local)
        saved = requests.last { it.path == "/mock-servers/upsert" }.body!!.path("spec")
        assertEquals("server", saved.path("envSource").asText()); assertEquals("public", saved.path("resourceWorkspaceId").asText()); assertFalse(saved.has("resourceIdentity"))
        exists = false; requests.clear(); tools.invoke("mock_upsert", args("""{"slug":"new","spec":{"routes":[]}}"""), local)
        saved = requests.last { it.path == "/mock-servers/upsert" }.body!!.path("spec")
        assertEquals("public", saved.path("resourceWorkspaceId").asText()); assertEquals("local", saved.path("envSource").asText())
        requests.clear(); assertThrows(IllegalArgumentException::class.java) { tools.invoke("mock_upsert", args("""{"slug":"invalid","spec":{"envSource":"local","routes":[]}}"""), server) }
        assertFalse(requests.any { it.method in setOf("POST", "PUT") })
    }

    @Test fun `public original rerun uses PC proxy without replacing saved source input or version`() {
        tools.invoke("execution_rerun", args("""{"id":"original"}"""), server)
        val run = requests.single { it.path.endsWith("/rerun") }
        assertTrue(run.pc); assertTrue(run.remote); assertNull(run.body)
        assertTrue(requests.any { it.path == "/flows/flow/versions/1" })
    }

    @Test fun `legacy original rerun stays direct and explicit new source opts a legacy run in without editing its graph`() {
        graph = json("""{"nodes":[{"id":"set","type":"set","executionAgent":"local"}],"edges":[]}""")
        tools.invoke("execution_rerun", args("""{"id":"original"}"""), server)
        val rerun = requests.single { it.path.endsWith("/rerun") }
        assertFalse(rerun.pc); assertNull(rerun.body)
        requests.clear(); tools.invoke("flow_run", args("""{"id":"flow","envName":"same","envSource":"server"}"""), server)
        val run = requests.single { it.path.endsWith("/runs") }
        assertEquals("public", run.body!!.path("resourceWorkspaceId").asText())
        assertEquals("SERVER", run.body.path("env").path("ORIGIN").asText())
        assertFalse(graph.has("resourceWorkspaceId"), "running an explicit source does not migrate a saved private graph")
    }

    @Test fun `suite preserves explicit source and input for every submitted flow`() {
        tools.invoke("suite_run", args("""{"flowIds":["flow"],"envName":"same","envSource":"local","input":{"order":"suite"}}"""), server)
        val run = requests.single { it.path.endsWith("/runs") }
        assertTrue(run.pc); assertTrue(run.remote)
        assertEquals("suite", run.body!!.path("input").path("order").asText())
        assertEquals("PC", run.body.path("env").path("ORIGIN").asText())
        assertFalse(run.body.has("onlyNodeId"))
    }

    @Test fun `only HTTP TCP browser and human nodes cause PC routing`() {
        for (node in listOf("""{"type":"http","executionAgent":"local"}""", """{"type":"tcp","executionAgent":"local"}""", """{"type":"http","reqMode":"client"}""", """{"type":"form"}""", """{"type":"input"}""")) {
            graph = mapper.createObjectNode().apply { set<JsonNode>("nodes", mapper.createArrayNode().add(json(node))) }
            requests.clear(); tools.invoke("flow_run", args("""{"id":"flow"}"""), server)
            assertTrue(requests.single { it.path.endsWith("/runs") }.pc, node)
        }
    }

    @Test fun `combined Mock keeps same IDs distinct and server results survive PC offline or lookup failure`() {
        val scoped = tools.scopeFor("mock_list", args("""{"target":"local"}"""), server)
        assertTrue(requests.isEmpty())
        val combined = mapper.valueToTree<JsonNode>(tools.invoke("mock_list", args(), scoped))
        assertEquals(listOf("server", "local"), combined.path("mocks").map { it.path("target").asText() })
        for (failure in listOf(McpApiException(404, "absent"), McpApiException(409, "offline"), IllegalStateException("connection failed"))) {
            pcError = failure; requests.clear()
            val result = mapper.valueToTree<JsonNode>(tools.invoke("mock_list", args(), scoped))
            assertEquals(1, result.path("mocks").size()); assertEquals("server", result.path("mocks").path(0).path("target").asText())
            assertFalse(result.path("sources").path(1).path("available").asBoolean())
        }
        serverError = McpApiException(503, "server unavailable")
        assertThrows(IllegalArgumentException::class.java) { tools.invoke("mock_list", args(), scoped) }
    }
}
