package com.flowlink.protocol

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.codec.CodecCtx
import com.flowlink.codec.FieldCodec
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.engine.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.net.ServerSocket
import java.util.Base64
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SecretDerivedTcpNodeTest {
    @Test fun `upstream secret is encoded on wire and stays bindable but is hidden from preview and stored outputs`() {
        val secret = "synthetic-value"
        val encoded = Base64.getEncoder().encodeToString(secret.toByteArray())
        val codec = object : FieldCodec {
            override fun id() = "synthetic-base64"
            override fun encode(value: String, ctx: CodecCtx) = Base64.getEncoder().encodeToString(value.toByteArray())
            override fun decode(value: String, ctx: CodecCtx) = String(Base64.getDecoder().decode(value))
        }
        val field = ProtocolSpec.Field("value", 20, "ascii", plugin = ProtocolSpec.PluginRef(codec.id()))
        val spec = ProtocolSpec(encoding = "UTF-8", framing = ProtocolSpec.Framing("fixed", fixedLength = 20), header = emptyList(), messages = listOf(ProtocolSpec.Message("request", fields = listOf(field)), ProtocolSpec.Message("response", fields = listOf(field))))
        val resources = object : ProtocolResources {
            override fun spec(reference: String, workspaceId: UUID?) = spec
            override fun plugins(workspaceId: UUID?) = ProtocolCodec.PluginLookup { codec }
        }
        val json = JsonService(jacksonObjectMapper())
        val executor = TcpNodeExecutor(TokenResolver(json), resources)
        val context = ExecutionContext().apply { putSeed("secret", mapOf("KEY" to secret)); putOutput("prior", mapOf("token" to secret)) }
        val worker = Executors.newSingleThreadExecutor()
        ServerSocket(0).use { server ->
            val peer = worker.submit<String> { server.accept().use { socket -> val bytes = socket.getInputStream().readNBytes(20); socket.getOutputStream().write(bytes); String(bytes) } }
            val node = json.mapper().readValue("""{"id":"tcp","type":"tcp","protocolId":"test","tcpMessage":"request","tcpHost":"127.0.0.1","tcpPort":${server.localPort},"tcpValues":{"value":"{{token@prior}}"}}""", GraphNode::class.java)
            val preview = executor.preview(node, context)
            assertTrue(preview.errors.isEmpty(), preview.errors.toString())
            assertFalse(json.toJson(preview).contains(encoded))
            val result = executor.execute(node, context)
            assertTrue(result.ok, result.responseText)
            assertEquals(encoded, peer.get(3, TimeUnit.SECONDS))
            assertEquals(secret, (result.value as Map<*, *>)["value"])
            assertEquals(secret, result.reqValues!!["value"])
            assertEquals("***", (result.storedValue as Map<*, *>)["value"])
            for (shown in listOf(result.requestText, result.responseText, json.toJson(result.storedValue))) {
                assertFalse(shown.orEmpty().contains(secret)); assertFalse(shown.orEmpty().contains(encoded))
            }
        }
        worker.shutdownNow()
    }
}
