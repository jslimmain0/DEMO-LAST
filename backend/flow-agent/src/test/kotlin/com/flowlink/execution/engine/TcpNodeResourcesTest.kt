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
    @Test fun `실제 snapshot 버전이 계획과 다르면 코덱 실행이나 TCP 전송 전에 실패한다`() {
        val json = JsonService(jacksonObjectMapper())
        var encoded = false
        val resources = object : ProtocolResources {
            override fun spec(reference: String, workspaceId: UUID?): ProtocolSpec = error("별도 spec 조회는 금지")
            override fun plugins(workspaceId: UUID?): ProtocolCodec.PluginLookup = error("별도 catalog 조회는 금지")
            override fun snapshot(reference: String, workspaceId: UUID?, resourceIdentity: com.flowlink.agent.CentralResourceIdentity?): com.flowlink.protocol.ResolvedProtocol =
                com.flowlink.protocol.ResolvedProtocol(ProtocolSpec(encoding = "UTF-8"), ProtocolCodec.PluginLookup { encoded = true; null }, "published-new-version")
        }
        val node = json.mapper().readValue("""{"id":"tcp","type":"tcp","protocolId":"wire","tcpMessage":"request","tcpHost":"127.0.0.1","tcpPort":1}""", GraphNode::class.java)
        val result = TcpNodeExecutor(TokenResolver(json), resources).execute(node, ExecutionContext().apply { expectedProtocolFingerprint = "plan-old-version" })
        assertThat(result.ok).isFalse()
        assertThat(result.uncertain).isFalse()
        assertThat(result.responseText).contains("버전이 실행 계획과 다릅니다")
        assertThat(encoded).isFalse()
    }

    @Test fun `TCP encode와 응답 decode는 같은 중앙 코덱 lookup을 사용하고 wire를 가리지 않는다`() {
        val json = JsonService(jacksonObjectMapper())
        val identity = com.flowlink.agent.CentralResourceIdentity("https://central.example", "alice")
        var lookups = 0
        val codec = object : com.flowlink.codec.FieldCodec {
            override fun id() = "reverse"
            override fun encode(value: String, ctx: com.flowlink.codec.CodecCtx) = value.reversed()
            override fun decode(value: String, ctx: com.flowlink.codec.CodecCtx) = value.reversed()
        }
        val resources = object : ProtocolResources {
            override fun spec(reference: String, workspaceId: UUID?): ProtocolSpec = error("개인 조회")
            override fun plugins(workspaceId: UUID?): ProtocolCodec.PluginLookup = error("개인 조회")
            override fun spec(reference: String, workspaceId: UUID?, resourceIdentity: com.flowlink.agent.CentralResourceIdentity?): ProtocolSpec {
                assertThat(resourceIdentity).isEqualTo(identity)
                val fields = listOf(ProtocolSpec.Field("value", 4, "string", plugin = ProtocolSpec.PluginRef("reverse")))
                return ProtocolSpec(encoding = "UTF-8", lengthField = "length", includesSelf = true,
                    header = listOf(ProtocolSpec.Field("length", 4, "length")),
                    messages = listOf(ProtocolSpec.Message("request", fields = fields), ProtocolSpec.Message("response", fields = fields)))
            }
            override fun plugins(workspaceId: UUID?, resourceIdentity: com.flowlink.agent.CentralResourceIdentity?): ProtocolCodec.PluginLookup {
                assertThat(resourceIdentity).isEqualTo(identity)
                lookups++
                check(lookups == 1) { "응답에서 승인 버전을 다시 조회하면 안 됩니다." }
                return ProtocolCodec.PluginLookup { codec }
            }
        }
        java.net.ServerSocket(0).use { server ->
            server.soTimeout = 5000
            val received = java.util.concurrent.CompletableFuture<String>()
            val worker = kotlin.concurrent.thread(isDaemon = true) {
                try {
                    server.accept().use { socket ->
                        socket.soTimeout = 5000
                        received.complete(String(socket.getInputStream().readNBytes(8)))
                        socket.getOutputStream().write("0008ZYXW".toByteArray())
                    }
                } catch (e: Exception) { received.completeExceptionally(e) }
            }
            try {
                val node = json.mapper().readValue("""{"id":"tcp","type":"tcp","protocolId":"central","tcpMessage":"request","tcpHost":"127.0.0.1","tcpPort":${server.localPort},"tcpValues":{"value":"ABCD"}}""", GraphNode::class.java)
                val result = TcpNodeExecutor(TokenResolver(json), resources).execute(node, ExecutionContext().apply { resourceIdentity = identity })
                assertThat(result.ok).isTrue()
                assertThat((result.value as Map<*, *>)["value"]).isEqualTo("WXYZ")
                assertThat(received.get(6, java.util.concurrent.TimeUnit.SECONDS)).isEqualTo("0008DCBA")
                assertThat(lookups).isEqualTo(1)
            } finally {
                server.close()
                worker.join(1000)
            }
        }
    }

    @Test fun `전문 미리보기는 시크릿 원문과 hex를 가리고 실제 조립 바이트는 유지한다`() {
        val json = JsonService(jacksonObjectMapper())
        val tokens = TokenResolver(json)
        val resources = object : ProtocolResources {
            override fun spec(reference: String, workspaceId: UUID?) = ProtocolSpec(encoding = "UTF-8", lengthField = "length", includesSelf = true,
                header = listOf(ProtocolSpec.Field("length", 4, "length")),
                messages = listOf(ProtocolSpec.Message("request", fields = listOf(ProtocolSpec.Field("value", if (reference == "escaped") 64 else 8, if (reference == "numeric") "numeric" else "string")))))
            override fun plugins(workspaceId: UUID?) = ProtocolCodec.NO_PLUGINS
        }
        val tcp = TcpNodeExecutor(tokens, resources)
        val flow = FlowExecutor(tokens, ExpressionEvaluator(tokens), org.mockito.Mockito.mock(HttpNodeExecutor::class.java), json,
            org.mockito.Mockito.mock(com.flowlink.transform.TransformRegistry::class.java), tcp)
        val node = json.mapper().readValue("""{"id":"tcp","type":"tcp","protocolId":"wire","tcpMessage":"request","tcpValues":{"value":"{{TOKEN@secret}}"}}""", GraphNode::class.java)
        val secret = "sensitive"
        val secrets = mapOf("TOKEN" to secret)
        val context = ExecutionContext().apply { putSeed("secret", secrets) }
        // 숫자 필드의 에러는 실제 입력을 포함하므로 에러 본문도 가려야 한다.
        val invalid = flow.previewTcp(node.copy(protocolId = "numeric"), secrets = secrets)
        assertThat(invalid.errors).isNotEmpty()
        assertThat(invalid.toString()).doesNotContain(secret)
        val validSecrets = mapOf("TOKEN" to "secret12")
        val result = flow.previewTcp(node, secrets = validSecrets)
        assertThat(result.errors).isEmpty()
        assertThat(result.text).doesNotContain("secret12")
        assertThat(result.fields.last().value).doesNotContain("secret12")
        assertThat(result.hex).doesNotContain(com.flowlink.common.tcp.TcpBytes.hexDump("secret12".toByteArray()))
        context.putSeed("secret", validSecrets)
        assertThat(String(tcp.build(node, context).encoded.bytes)).isEqualTo("0012secret12")

        val urlSecret = "k y+/="
        val jsonSecret = "say \"hi\"\nnow"
        val encodedJson = json.mapper().writeValueAsString(jsonSecret).let { it.substring(1, it.length - 1) }
        for ((original, escaped) in listOf(urlSecret to java.net.URLEncoder.encode(urlSecret, Charsets.UTF_8), jsonSecret to encodedJson)) {
            val escapedNode = node.copy(protocolId = "escaped", tcpValues = mapOf("value" to escaped))
            val escapedSecrets = mapOf("TOKEN" to original)
            val escapedPreview = flow.previewTcp(escapedNode, secrets = escapedSecrets)
            assertThat(escapedPreview.errors).isEmpty()
            assertThat(escapedPreview.total).isEqualTo(68)
            assertThat(escapedPreview.text).doesNotContain(escaped)
            assertThat(escapedPreview.fields.last().value).doesNotContain(escaped)
            assertThat(escapedPreview.hex).doesNotContain(com.flowlink.common.tcp.TcpBytes.hexDump(escaped.toByteArray()))
            val escapedContext = ExecutionContext().apply { putSeed("secret", escapedSecrets) }
            assertThat(String(tcp.build(escapedNode, escapedContext).encoded.bytes)).contains(escaped)
        }
    }

    @Test fun `PC 전문 미리보기는 명시된 중앙 서버 계정을 호스트 자원 조회에 전달한다`() {
        val json = JsonService(jacksonObjectMapper())
        val identity = com.flowlink.agent.CentralResourceIdentity("https://central.example", "alice")
        val calls = mutableListOf<com.flowlink.agent.CentralResourceIdentity?>()
        val resources = object : ProtocolResources {
            override fun spec(reference: String, workspaceId: UUID?): ProtocolSpec = error("개인 규격으로 대체하면 안 됩니다.")
            override fun plugins(workspaceId: UUID?): ProtocolCodec.PluginLookup = error("개인 코덱으로 대체하면 안 됩니다.")
            override fun spec(reference: String, workspaceId: UUID?, resourceIdentity: com.flowlink.agent.CentralResourceIdentity?): ProtocolSpec {
                calls += resourceIdentity
                assertThat(workspaceId).isNull()
                return ProtocolSpec(encoding = "UTF-8", lengthField = "length", includesSelf = true,
                    header = listOf(ProtocolSpec.Field("length", 4, "length")),
                    messages = listOf(ProtocolSpec.Message("request", fields = listOf(ProtocolSpec.Field("value", 4, "string")))))
            }
            override fun plugins(workspaceId: UUID?, resourceIdentity: com.flowlink.agent.CentralResourceIdentity?): ProtocolCodec.PluginLookup {
                calls += resourceIdentity
                return ProtocolCodec.NO_PLUGINS
            }
        }
        val node = json.mapper().readValue("""{"id":"tcp","type":"tcp","protocolId":"중앙","tcpMessage":"request","tcpValues":{"value":"PC"}}""", GraphNode::class.java)
        val result = TcpNodeExecutor(TokenResolver(json), resources).preview(node, ExecutionContext().apply { resourceIdentity = identity })
        assertThat(result.errors).isEmpty()
        assertThat(result.text).isEqualTo("0008PC  ")
        assertThat(calls).containsExactly(identity, identity)
    }

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
