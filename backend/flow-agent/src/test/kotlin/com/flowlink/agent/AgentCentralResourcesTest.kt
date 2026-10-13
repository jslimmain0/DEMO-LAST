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
import org.mockito.ArgumentCaptor
import org.mockito.Mockito.*
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.*
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient
import java.util.UUID

class AgentCentralResourcesTest {
    private val json = JsonService(jacksonObjectMapper())
    private val tokens = TokenResolver(json)
    private val owner = UUID.randomUUID()
    private val identity = CentralResourceIdentity("https://company.test", "alice")
    private fun node(text: String) = json.mapper().readValue(text, GraphNode::class.java)
    private fun resources(local: Boolean): AgentResources = mock(AgentResources::class.java).also {
        `when`(it.localRuntime).thenReturn(local)
        `when`(it.workspaceScope("owner")).thenReturn(owner)
        `when`(it.workspaceScope("public")).thenReturn(null)
        `when`(it.environmentExists("dev", owner)).thenReturn(true)
        `when`(it.environmentExists("dev", null)).thenReturn(true)
        `when`(it.environment("dev", owner)).thenReturn(mapOf("ORIGIN" to "pc"))
        `when`(it.environment("dev", null)).thenReturn(mapOf("ORIGIN" to "central"))
        `when`(it.centralEnvironment("dev", identity)).thenReturn(mapOf("ORIGIN" to "central"))
        `when`(it.secrets("dev", owner)).thenReturn(emptyMap())
        `when`(it.secrets("dev", null)).thenReturn(emptyMap())
        `when`(it.secrets(null, null)).thenReturn(emptyMap())
    }
    private fun realExecutor(resources: AgentResources, rest: RestClient): AgentNodeExecutor {
        val transforms = mock(TransformRegistry::class.java)
        val engine = FlowExecutor(tokens, ExpressionEvaluator(tokens), HttpNodeExecutor(rest, tokens, json, ExecutionProperties(null)),
            json, transforms, TcpNodeExecutor(tokens, mock(ProtocolResources::class.java)))
        return AgentNodeExecutor(engine, resources, json, tokens, transforms)
    }

    @Test fun `explicit environment source executes the same selection on both runtimes without merging another store`() {
        for (local in listOf(true, false)) for (source in listOf("local", "server")) {
            val resources = resources(local)
            val rest = RestClient.builder()
            val server = MockRestServiceServer.bindTo(rest).build()
            val expected = if (source == "local") "pc" else "central"
            server.expect(requestTo("https://$expected.test")).andRespond(withSuccess("ok", MediaType.TEXT_PLAIN))
            val n = node("""{"id":"n","type":"http","executionAgent":"${if (local) "local" else "server"}","baseUrl":"https://{{ ORIGIN@env }}.test","respType":"text"}""")
            val request = AgentNodeRequest(UUID.randomUUID(), UUID.randomUUID(), n, workspaceId = "owner", envName = "dev", resourceWorkspaceId = "public",
                resourceIdentity = identity, envSource = source, allowedOutputs = listOf("body"),
                seeds = if (!local && source == "local") mapOf("env" to mapOf("ORIGIN" to "pc")) else emptyMap())
            val result = realExecutor(resources, rest.build()).execute(request).result
            assertTrue(result.ok, result.responseText)
            server.verify()
            if (!local && source == "local") {
                verify(resources, never()).environment("dev", owner)
                verify(resources, never()).environment("dev", null)
            }
            if (local && source == "server") verify(resources, atLeastOnce()).centralEnvironment("dev", identity)
        }
    }

    @Test fun `PC HTTP receives only referenced central secrets and displays masked request body while outputs remain restricted`() {
        val resources = resources(true)
        `when`(resources.centralSecrets(null, setOf("TOKEN"), identity)).thenReturn(mapOf("TOKEN" to "central-sensitive"))
        val rest = RestClient.builder()
        val server = MockRestServiceServer.bindTo(rest).build()
        server.expect(requestTo("https://example.test")).andExpect(header("Authorization", "Bearer central-sensitive"))
            .andExpect(content().string("show-me central-sensitive"))
            .andRespond(withSuccess("hidden response", MediaType.TEXT_PLAIN))
        val n = node("""{"id":"n","type":"http","executionAgent":"local","method":"POST","baseUrl":"https://example.test","bodyType":"raw","rawBody":"show-me {{ TOKEN@secret }}","headersRaw":true,"rawHeaders":"Authorization: Bearer {{ TOKEN@secret }}","respType":"text"}""")
        val request = AgentNodeRequest(UUID.randomUUID(), UUID.randomUUID(), n, workspaceId = "owner", envName = "dev", resourceWorkspaceId = "public",
            resourceIdentity = identity, envSource = "local", allowedOutputs = listOf("httpStatus"))
        val result = realExecutor(resources, rest.build()).execute(request).result
        assertTrue(result.ok, result.responseText)
        assertTrue(result.requestText.orEmpty().contains("show-me"), "PC request body remains useful for debugging")
        assertFalse(result.toString().contains("central-sensitive"))
        assertFalse(result.responseText.orEmpty().contains("hidden response"), "response output policy remains unchanged")
        assertEquals(mapOf("httpStatus" to 200), result.value)
        verify(resources).centralSecrets(null, setOf("TOKEN"), identity)
        verify(resources, never()).centralSecrets("dev", setOf("TOKEN"), identity)
        verify(resources, never()).secrets("dev", owner)
        server.verify()
    }

    @Test fun `PC TCP includes secret keys used by central protocol codecs and pins protocol context identity`() {
        val resources = resources(true)
        `when`(resources.centralProtocolFingerprint("wire", identity)).thenReturn("public-wire")
        `when`(resources.centralProtocolSecretKeys("wire", identity)).thenReturn(setOf("IV"))
        `when`(resources.centralSecrets(null, setOf("IV"), identity)).thenReturn(mapOf("IV" to "central-iv"))
        val n = node("""{"id":"n","type":"tcp","executionAgent":"local","protocolId":"wire","tcpMessage":"request"}""")
        val engine = mock(FlowExecutor::class.java)
        `when`(engine.runSingleNode(any(GraphNode::class.java) ?: n, any(ExecutionContext::class.java) ?: ExecutionContext())).thenReturn(NodeResult.ok(null, "wire request", "wire response", mapOf("status" to "ok")))
        val executor = AgentNodeExecutor(engine, resources, json, tokens, mock(TransformRegistry::class.java))
        val request = AgentNodeRequest(UUID.randomUUID(), UUID.randomUUID(), n, workspaceId = "owner", envName = "dev", resourceWorkspaceId = "public", resourceIdentity = identity,
            envSource = "local", dependencyHashes = mapOf("protocol" to "public-wire"))
        assertTrue(executor.execute(request).result.ok)
        val context = ArgumentCaptor.forClass(ExecutionContext::class.java)
        verify(engine).runSingleNode(eq(n) ?: n, context.capture() ?: ExecutionContext())
        assertNull(context.value.workspaceId)
        assertEquals(identity, context.value.resourceIdentity)
        assertEquals("public-wire", context.value.expectedProtocolFingerprint)
        assertEquals(mapOf("IV" to "central-iv"), context.value.raw("secret"))
        verify(resources).centralSecrets(null, setOf("IV"), identity)
        verify(resources, never()).protocolFingerprint("wire", owner)
    }

    @Test fun `common resource opt-in still runs pure PC HTTP offline without querying central resources`() {
        val resources = resources(true)
        val rest = RestClient.builder()
        val server = MockRestServiceServer.bindTo(rest).build()
        server.expect(requestTo("https://pc.test")).andRespond(withSuccess("offline-safe", MediaType.TEXT_PLAIN))
        val n = node("""{"id":"n","type":"http","executionAgent":"local","baseUrl":"https://{{ ORIGIN@env }}.test","respType":"text"}""")
        val request = AgentNodeRequest(UUID.randomUUID(), UUID.randomUUID(), n, workspaceId = "owner", envName = "dev",
            resourceWorkspaceId = "public", envSource = "local", resourceIdentity = CentralResourceIdentity("", null), allowedOutputs = listOf("body"))
        val result = realExecutor(resources, rest.build()).execute(request).result
        assertTrue(result.ok, result.responseText)
        verify(resources, never()).centralEnvironment(anyString(), any(CentralResourceIdentity::class.java) ?: identity)
        verify(resources, never()).centralSecrets(anyString(), anySet<String>(), any(CentralResourceIdentity::class.java) ?: identity)
        verify(resources, never()).secrets("dev", owner)
        verify(resources, never()).secrets(null, null)
        server.verify()
    }

    @Test fun `server requests remain visible with either environment source while secrets and unselected responses stay masked`() {
        for (source in listOf("local", "server")) {
            val resources = resources(false)
            `when`(resources.secrets(null, null)).thenReturn(mapOf("TOKEN" to "common-secret"))
            `when`(resources.secrets("dev", null)).thenReturn(mapOf("TOKEN" to "server-dev-secret"))
            val rest = RestClient.builder()
            val server = MockRestServiceServer.bindTo(rest).build()
            val expectedOrigin = if (source == "local") "pc" else "central"
            val expectedSecret = if (source == "local") "common-secret" else "server-dev-secret"
            server.expect(requestTo("https://$expectedOrigin.test")).andExpect(header("Authorization", expectedSecret))
                .andExpect(content().string("server-request-32100 $expectedSecret"))
                .andRespond(withSuccess("hidden server response", MediaType.TEXT_PLAIN))
            val n = node("""{"id":"n","type":"http","executionAgent":"server","method":"POST","baseUrl":"https://{{ ORIGIN@env }}.test","headersRaw":true,"rawHeaders":"Authorization: {{ TOKEN@secret }}","bodyType":"raw","rawBody":"server-request-32100 {{ TOKEN@secret }}","respType":"text"}""")
            val request = AgentNodeRequest(UUID.randomUUID(), UUID.randomUUID(), n, workspaceId = "owner", envName = "dev",
                resourceWorkspaceId = "public", envSource = source, allowedOutputs = listOf("httpStatus"),
                seeds = if (source == "local") mapOf("env" to mapOf("ORIGIN" to "pc")) else emptyMap())
            val result = realExecutor(resources, rest.build()).execute(request).result
            assertTrue(result.ok, result.responseText)
            assertTrue(result.requestText.orEmpty().contains("POST https://$expectedOrigin.test"))
            assertTrue(result.requestText.orEmpty().contains("Authorization"))
            assertTrue(result.requestText.orEmpty().contains("server-request-32100"))
            assertFalse(result.toString().contains(expectedSecret))
            assertFalse(result.responseText.orEmpty().contains("hidden server response"))
            assertEquals(mapOf("httpStatus" to 200), result.value)
            verify(resources).secrets(if (source == "local") null else "dev", null)
            verify(resources, never()).secrets("dev", owner)
            server.verify()
        }
    }

    @Test fun `missing PC snapshot or central identity fails before executing and no arbitrary common scope is accepted`() {
        val resources = resources(false)
        val engine = mock(FlowExecutor::class.java)
        val executor = AgentNodeExecutor(engine, resources, json, tokens, mock(TransformRegistry::class.java))
        val n = node("""{"id":"n","type":"http","executionAgent":"server"}""")
        val request = AgentNodeRequest(UUID.randomUUID(), UUID.randomUUID(), n, workspaceId = "owner", envName = "dev", envSource = "local")
        assertFalse(executor.execute(request).result.ok)
        assertFalse(executor.execute(request.copy(resourceWorkspaceId = owner.toString())).result.ok)
        verifyNoInteractions(engine)
        val local = AgentNodeExecutor(engine, resources(true), json, tokens, mock(TransformRegistry::class.java))
        assertFalse(local.execute(request.copy(node = n.copy(executionAgent = "local"), envSource = "server", resourceWorkspaceId = "public")).result.ok)
        verifyNoInteractions(engine)
    }
}
