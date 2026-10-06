package com.flowlink.execution.engine

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import com.flowlink.protocol.ProtocolCodec
import com.flowlink.protocol.ProtocolResources
import com.flowlink.protocol.ProtocolSpec
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.util.UUID

class TcpNodeResourcesTest {
    @Test
    fun `DB 없이 호스트가 제공한 공간의 규격으로 전문을 조립한다`() {
        val json = JsonService(jacksonObjectMapper())
        val scope = UUID.randomUUID()
        val calls = mutableListOf<Pair<String, UUID?>>()
        val resources = object : ProtocolResources {
            override fun spec(reference: String, workspaceId: UUID?): ProtocolSpec {
                calls += reference to workspaceId
                return ProtocolSpec(
                    encoding = "UTF-8", lengthField = "length", includesSelf = true,
                    header = listOf(ProtocolSpec.Field("length", 4, "length")),
                    messages = listOf(ProtocolSpec.Message("request", fields = listOf(ProtocolSpec.Field("value", 4, "string")))),
                )
            }
            override fun plugins(workspaceId: UUID?): ProtocolCodec.PluginLookup {
                calls += "plugins" to workspaceId
                return ProtocolCodec.NO_PLUGINS
            }
        }
        val node = json.mapper().readValue("""{
            "id":"tcp", "type":"tcp", "protocolId":"원장 전문", "tcpMessage":"request",
            "tcpHost":"127.0.0.1", "tcpPort":19091, "tcpValues":{"value":"OK"}
        }""", GraphNode::class.java)
        val context = ExecutionContext().apply { workspaceId = scope }
        val result = TcpNodeExecutor(TokenResolver(json), resources).preview(node, context)

        assertThat(result.errors).isEmpty()
        assertThat(result.text).isEqualTo("0008OK  ")
        assertThat(calls).containsExactly("원장 전문" to scope, "plugins" to scope)
    }
}
