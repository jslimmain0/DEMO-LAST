package com.flowlink.agent

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.engine.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*

class AgentTargetDiagnosticsTest {
    @Test fun `browser Mock combination cannot report agent Mock as effective address`() {
        val mapper = jacksonObjectMapper()
        val json = JsonService(mapper)
        val environments = mock(com.flowlink.environment.EnvironmentService::class.java)
        val secrets = mock(com.flowlink.secret.SecretService::class.java)
        `when`(environments.vars(null, null)).thenReturn(emptyMap())
        `when`(secrets.activeSecrets(null, null)).thenReturn(emptyMap())
        val executor = AgentNodeExecutor(mock(FlowExecutor::class.java), mock(com.flowlink.workspace.WorkspaceService::class.java), environments, secrets,
            mock(com.flowlink.mock.MockServerService::class.java), json, TokenResolver(json), mock(com.flowlink.protocol.ProtocolService::class.java), mock(com.flowlink.transform.TransformRegistry::class.java))
        val node = mapper.readValue("""{"id":"n","type":"http","reqMode":"client","agentMock":"payment","baseUrl":"http://direct.test"}""", GraphNode::class.java)
        assertThrows(com.flowlink.common.error.BadRequestException::class.java) { executor.targetDiagnostics(node, null, null) }
    }

    private fun mockExecutor(target: com.flowlink.mock.MockServerService.AgentMockTarget): Pair<AgentNodeExecutor, JsonService> {
        val json = JsonService(jacksonObjectMapper())
        val environments = mock(com.flowlink.environment.EnvironmentService::class.java)
        val secrets = mock(com.flowlink.secret.SecretService::class.java)
        val mocks = mock(com.flowlink.mock.MockServerService::class.java)
        `when`(environments.vars(null, null)).thenReturn(mapOf("PATH" to "/probe", "HOST" to "ignored"))
        `when`(secrets.activeSecrets(null, null)).thenReturn(mapOf("TOKEN" to "dummy-secret"))
        `when`(mocks.resolveAgentTarget("payment", null)).thenReturn(target)
        return AgentNodeExecutor(mock(FlowExecutor::class.java), mock(com.flowlink.workspace.WorkspaceService::class.java), environments, secrets,
            mocks, json, TokenResolver(json), mock(com.flowlink.protocol.ProtocolService::class.java), mock(com.flowlink.transform.TransformRegistry::class.java)) to json
    }
    @Test fun `HTTP Mock diagnostic includes unchanged path exactly as request builder and masks secrets`() {
        val base = "http://127.0.0.1:18182/mock/ws/team/payment/"
        val (executor, json) = mockExecutor(com.flowlink.mock.MockServerService.AgentMockTarget(base, null, null))
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
        val (executor, json) = mockExecutor(com.flowlink.mock.MockServerService.AgentMockTarget("http://127.0.0.1:18182/mock/payment", null, null))
        val node = json.mapper().readValue("""{"id":"n","type":"http","agentMock":"payment","path":"{{PATH@previous}}"}""", GraphNode::class.java)
        val result = executor.targetDiagnostics(node, null, null)
        assertNull(result["resolvedTarget"])
        assertEquals("upstream-binding", result["source"])
        assertTrue(result["warnings"].toString().contains("상류"))
    }
    @Test fun `TCP Mock diagnostic uses listener host and port and ignores overridden port key`() {
        val (executor, json) = mockExecutor(com.flowlink.mock.MockServerService.AgentMockTarget("http://127.0.0.1:18182/mock/payment", "127.0.0.1", 19100))
        val node = json.mapper().readValue("""{"id":"n","type":"tcp","agentMock":"payment","tcpHost":"{{MISSING@env}}","tcpPort":7,"tcpPortEnvKey":"MISSING"}""", GraphNode::class.java)
        val result = executor.targetDiagnostics(node, null, null)
        assertEquals("127.0.0.1:19100", result["resolvedTarget"])
        assertEquals("destination-mock", result["source"])
    }
}
