package com.flowlink.agent

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.engine.*
import com.flowlink.execution.config.ExecutionProperties
import com.flowlink.protocol.ProtocolResources
import com.flowlink.transform.TransformRegistry
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.web.client.RestClient
import java.util.UUID

class AgentTargetDiagnosticsTest {
    @Test fun `calculation readiness ignores legacy destination and Mock fields`() {
        val json = JsonService(jacksonObjectMapper())
        for (local in listOf(true, false)) {
            val resources = mock(AgentResources::class.java)
            val space = UUID.randomUUID()
            `when`(resources.localRuntime).thenReturn(local)
            `when`(resources.workspaceScope("owner")).thenReturn(space)
            `when`(resources.environmentExists("workflow-env", space)).thenReturn(true)
            `when`(resources.environment("workflow-env", space)).thenReturn(emptyMap())
            `when`(resources.secrets("workflow-env", space)).thenReturn(emptyMap())
            val executor = AgentNodeExecutor(mock(FlowExecutor::class.java), resources, json, TokenResolver(json), mock(TransformRegistry::class.java))
            for (type in listOf("set", "if", "assert", "switch")) {
                val node = json.mapper().readValue("""{"id":"calc","type":"$type","executionAgent":"${if (local) "server" else "local"}","agentWorkspaceId":"other-team","agentEnvironment":"missing","agentMock":"missing-mock"}""", GraphNode::class.java)
                assertTrue(executor.inspect(node, "owner", "workflow-env").isEmpty())
                assertDoesNotThrow { executor.targetDiagnostics(node, "owner", "workflow-env") }
            }
            verify(resources, never()).mockTarget(anyString(), any())
        }
    }
    @Test fun `browser Mock combination cannot report agent Mock as effective address`() {
        val mapper = jacksonObjectMapper()
        val json = JsonService(mapper)
        val resources = mock(AgentResources::class.java)
        `when`(resources.environment(null, null)).thenReturn(emptyMap())
        `when`(resources.secrets(null, null)).thenReturn(emptyMap())
        val executor = AgentNodeExecutor(mock(FlowExecutor::class.java), resources,
            json, TokenResolver(json), mock(TransformRegistry::class.java))
        val node = mapper.readValue("""{"id":"n","type":"http","reqMode":"client","agentMock":"payment","baseUrl":"http://direct.test"}""", GraphNode::class.java)
        assertThrows(com.flowlink.common.error.BadRequestException::class.java) { executor.targetDiagnostics(node, null, null) }
    }

    private fun mockExecutor(target: AgentMockTarget): Pair<AgentNodeExecutor, JsonService> {
        val json = JsonService(jacksonObjectMapper())
        val resources = mock(AgentResources::class.java)
        `when`(resources.environment(null, null)).thenReturn(mapOf("PATH" to "/probe", "HOST" to "ignored"))
        `when`(resources.secrets(null, null)).thenReturn(mapOf("TOKEN" to "dummy-secret"))
        `when`(resources.mockTarget("payment", null)).thenReturn(target)
        return AgentNodeExecutor(mock(FlowExecutor::class.java), resources,
            json, TokenResolver(json), mock(TransformRegistry::class.java)) to json
    }
    @Test fun `HTTP Mock diagnostic includes unchanged path exactly as request builder and masks secrets`() {
        val base = "http://127.0.0.1:18182/mock/ws/team/payment/"
        val (executor, json) = mockExecutor(AgentMockTarget(base, null, null))
        val node = json.mapper().readValue("""{"id":"n","type":"http","agentMock":"payment","baseUrl":"{{MISSING@env}}","path":"{{PATH@env}}/{{TOKEN@secret}}?credential={{TOKEN@secret}}"}""", GraphNode::class.java)
        val result = executor.targetDiagnostics(node, null, null)
        val tokens = TokenResolver(json)
        val ctx = ExecutionContext().apply { putOutput("env", mapOf("PATH" to "/probe")); putSeed("secret", mapOf("TOKEN" to "dummy-secret")) }
        val built = HttpNodeExecutor(org.springframework.web.client.RestClient.create(), tokens, json, com.flowlink.execution.config.ExecutionProperties(null)).build(node.copy(baseUrl = base, baseUrlBound = null), ctx)
        assertEquals(base + "/probe/dummy-secret?credential=dummy-secret", built.url)
        assertEquals(base + "/probe/••••••", result["resolvedTarget"])
        assertFalse(result.toString().contains("dummy-secret"))
        assertFalse(result.toString().contains("credential="))
        assertEquals("destination-mock", result["source"])
        assertEquals("agent", result["requester"])
        assertFalse(result["warnings"].toString().contains("고정 주소"))
        assertTrue(result["warnings"].toString().contains("네트워크"))
    }
    @Test fun `Mock path from upstream is deferred rather than reporting base as full target`() {
        val (executor, json) = mockExecutor(AgentMockTarget("http://127.0.0.1:18182/mock/payment", null, null))
        val node = json.mapper().readValue("""{"id":"n","type":"http","agentMock":"payment","path":"{{PATH@previous}}"}""", GraphNode::class.java)
        val result = executor.targetDiagnostics(node, null, null)
        assertNull(result["resolvedTarget"])
        assertEquals("upstream-binding", result["source"])
        assertTrue(result["warnings"].toString().contains("상류"))
    }
    @Test fun `TCP Mock diagnostic uses listener host and port and ignores overridden port key`() {
        val (executor, json) = mockExecutor(AgentMockTarget("http://127.0.0.1:18182/mock/payment", "127.0.0.1", 19100))
        val node = json.mapper().readValue("""{"id":"n","type":"tcp","agentMock":"payment","tcpHost":"{{MISSING@env}}","tcpPort":7,"tcpPortEnvKey":"MISSING"}""", GraphNode::class.java)
        val result = executor.targetDiagnostics(node, null, null)
        assertEquals("127.0.0.1:19100", result["resolvedTarget"])
        assertEquals("destination-mock", result["source"])
    }

    @Test fun `local and server jobs use their supplied destination resources and mask returned secrets`() {
        for (location in listOf("local", "server")) {
            val json = JsonService(jacksonObjectMapper())
            val tokens = TokenResolver(json)
            val resources = mock(AgentResources::class.java)
            val scope = UUID.randomUUID()
            `when`(resources.localRuntime).thenReturn(location == "local")
            `when`(resources.workspaceScope(scope.toString())).thenReturn(scope)
            `when`(resources.environmentExists("dev", scope)).thenReturn(true)
            `when`(resources.environment("dev", scope)).thenReturn(mapOf("ORIGIN" to location))
            `when`(resources.secrets("dev", scope)).thenReturn(mapOf("TOKEN" to "$location-private-value"))
            val transforms = mock(TransformRegistry::class.java)
            val engine = FlowExecutor(tokens, ExpressionEvaluator(tokens),
                HttpNodeExecutor(RestClient.create(), tokens, json, ExecutionProperties(null)),
                json, transforms, TcpNodeExecutor(tokens, mock(ProtocolResources::class.java)))
            val executor = AgentNodeExecutor(engine, resources, json, tokens, transforms)
            val node = json.mapper().readValue("""{
                "id":"n", "type":"set", "executionAgent":"$location",
                "vars":[{"key":"origin","value":"{{ORIGIN@env}}"},{"key":"credential","value":"{{TOKEN@secret}}"}]
            }""", GraphNode::class.java)
            val request = AgentNodeRequest(UUID.randomUUID(), UUID.randomUUID(), node,
                workspaceId = scope.toString(), envName = "dev", allowedOutputs = listOf("origin", "credential"))

            val result = executor.execute(request).result

            assertTrue(result.ok, result.responseText)
            assertEquals(location, (result.value as Map<*, *>)["origin"])
            assertFalse(result.toString().contains("$location-private-value"))
            verify(resources).environment("dev", scope)
            verify(resources).secrets("dev", scope)
            val otherLocation = if (location == "local") "server" else "local"
            val wrongLocation = executor.execute(request.copy(node = node.copy(executionAgent = otherLocation))).result
            assertFalse(wrongLocation.ok)
            assertTrue(wrongLocation.responseText.orEmpty().contains("실행 프로세스가 다릅니다"))
        }
    }
}
