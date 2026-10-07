package com.flowlink.agent

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.engine.ExecutionContext
import com.flowlink.execution.engine.TokenResolver
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

class AgentRequestBuilderTest {
    private val mapper = jacksonObjectMapper()
    private val builder = AgentRequestBuilder(JsonService(mapper), TokenResolver(JsonService(mapper)))
    private fun node(raw: String) = mapper.readValue(raw, GraphNode::class.java)
    private val run = AgentRunOptions(UUID.randomUUID(), "pc-device", "server", "dev", "public", "development", agentEnvironments = mapOf("local" to "", "server:public" to ""))

    @Test fun `HTTP default outputs preserve body and status across both execution directions`() {
        for (owner in listOf("local", "server")) for (responseType in listOf("json", "text", "binary", "xml", "urlencoded", "query")) {
            val agent = if (owner == "local") "server" else "local"
            val n = node("""{"id":"n","type":"http","executionAgent":"$agent","respType":"$responseType","outputs":[{"key":"data"},{"key":"id"}]}""")
            val request = builder.build(n, listOf(n), ExecutionContext(), run.copy(ownerAgent = owner), 0)
            assertTrue(request.crossBoundary)
            assertEquals(listOf("data", "id", "body", "httpStatus"), request.allowedOutputs)
            assertEquals(listOf("data"), builder.build(n.copy(agentOutputs = listOf("data")), listOf(n), ExecutionContext(), run.copy(ownerAgent = owner), 0).allowedOutputs)
            assertTrue(builder.build(n.copy(agentOutputs = emptyList()), listOf(n), ExecutionContext(), run.copy(ownerAgent = owner), 0).allowedOutputs.isEmpty())
        }
    }

    @Test fun `plugin transform ignores old destinations and is forbidden in personal workflows`() {
        val n = node("""{"id":"plugin","type":"transform","transformId":"test","executionAgent":"local","agentWorkspaceId":"other-team","agentEnvironment":"old-env"}""")
        val request = builder.build(n, listOf(n), ExecutionContext(), run, 0)
        assertEquals("server", request.node.executionAgent)
        assertEquals("public", request.workspaceId)
        assertEquals("development", request.envName)
        assertFalse(request.crossBoundary)
        assertThrows(BadRequestException::class.java) { builder.build(n, listOf(n), ExecutionContext(), run.copy(ownerAgent = "local"), 0) }
        val http = node("""{"id":"request","type":"http","executionAgent":"server","baseUrl":"http://example.test","headersRaw":true,"rawHeaders":"Authorization: {{ token@secret }}"}""")
        assertThrows(BadRequestException::class.java) { builder.build(http, listOf(http), ExecutionContext(), run.copy(ownerAgent = "local"), 0) }
    }

    @Test fun `crossing request preserves typed required inputs and resolves environment at destination`() {
        val ctx = ExecutionContext().apply {
            putOutput("env", mapOf("marker" to "SERVER", "ignored" to "private"))
            putOutput("before", mapOf("amount" to 42, "ok" to true, "data" to listOf("한글"), "hidden" to "private"))
            putSeed("secret", mapOf("key" to "not-for-transport"))
        }
        val n = node("""{"id":"next","type":"http","executionAgent":"local","baseUrl":"http://example.test/{{ marker }}", "fields":{"body":[{"key":"amount","value":"{{ amount@before }}"},{"key":"ok","value":"{{ ok }}"},{"key":"data","value":"{{ data@before }}"},{"key":"token","value":"{{ key@secret }}"}]}}""")
        val request = builder.build(n, listOf(n), ctx, run, 3)
        assertEquals("", request.envName)
        assertFalse(request.values.containsKey("env"))
        assertFalse(request.values.containsKey("secret"))
        assertEquals(42, (request.values["before"] as Map<*, *>)["amount"])
        assertEquals(listOf("한글"), (request.values["before"] as Map<*, *>)["data"])
        assertEquals(mapOf("ok" to true), request.values["__agent_inputs"])
        assertFalse(mapper.writeValueAsString(request).contains("not-for-transport"))
        assertFalse(mapper.writeValueAsString(request).contains("private"))
        assertEquals(request.taskId, builder.build(n, listOf(n), ctx, run, 3).taskId)
    }

    @Test fun `secret echoed by upstream cannot be exported and explicit empty output list remains empty`() {
        val ctx = ExecutionContext().apply {
            putSeed("secret", mapOf("token" to "super-secret"))
            putOutput("before", mapOf("echo" to "super-secret"))
        }
        val n = node("""{"id":"next","type":"set","executionAgent":"local","agentOutputs":[],"vars":[{"key":"echo","value":"{{ echo@before }}"}]}""")
        assertThrows(BadRequestException::class.java) { builder.build(n, listOf(n), ctx, run, 0) }
        ctx.putOutput("before", mapOf("echo" to "safe"))
        assertEquals(emptyList<String>(), builder.build(n, listOf(n), ctx, run, 0).allowedOutputs)
    }

    @Test fun `different workspace on same server also has a data boundary`() {
        val ctx = ExecutionContext().apply { putOutput("env", mapOf("marker" to "OWNER")) }
        val n = node("""{"id":"next","type":"set","executionAgent":"server","agentWorkspaceId":"${UUID.randomUUID()}","agentEnvironment":"","vars":[]}""")
        val request = builder.build(n, listOf(n), ctx, run, 0)
        assertTrue(request.crossBoundary)
        assertTrue(request.seeds.isEmpty())
        assertEquals("", request.envName)
    }

    @Test fun `crossing without destination environment fails instead of common fallback`() {
        val n = node("""{"id":"n","type":"set","executionAgent":"local","vars":[]}""")
        assertThrows(BadRequestException::class.java) { builder.build(n, listOf(n), ExecutionContext(), run.copy(agentEnvironments = emptyMap()), 0) }
        assertEquals("development", builder.build(n, listOf(n), ExecutionContext(), run.copy(agentEnvironments = mapOf("local" to "development")), 0).envName)
        assertEquals("", builder.build(n.copy(agentEnvironment = ""), listOf(n), ExecutionContext(), run, 0).envName)
    }

    @Test fun `explicit common and node override never carry owner environment seed`() {
        val n = node("""{"id":"n","type":"set","executionAgent":"server","vars":[]}""")
        val ctx = ExecutionContext().apply { putOutput("env", mapOf("URL" to "owner-only")) }
        val common = builder.build(n, listOf(n), ctx, run, 0)
        assertEquals("", common.envName)
        assertFalse(common.seeds.containsKey("env"))
        val override = builder.build(n.copy(agentEnvironment = "other"), listOf(n), ctx, run, 0)
        assertEquals("other", override.envName)
        assertFalse(override.seeds.containsKey("env"))
        val inherited = builder.build(n, listOf(n), ctx, run.copy(agentEnvironments = emptyMap()), 0)
        assertEquals("development", inherited.envName)
        assertTrue(inherited.seeds.containsKey("env"))
    }
}
