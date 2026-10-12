package com.flowlink.protocol

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.agent.CentralResourceIdentity
import com.flowlink.codec.CodecCtx
import com.flowlink.codec.FieldCodec
import com.flowlink.codec.FieldInfo
import com.flowlink.codec.MessageCodec
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.host.CentralCodecDescriptor
import com.flowlink.common.host.CentralCodecRequest
import com.flowlink.common.host.CentralProtocolSnapshot
import com.flowlink.common.host.LocalServerResources
import com.flowlink.common.json.JsonService
import com.flowlink.core.repository.ProtocolRepository
import com.flowlink.mock.MockSecretProvider
import com.flowlink.transform.TransformRegistry
import com.flowlink.workspace.ResourceWorkspace
import com.flowlink.workspace.WorkspaceService
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.ApplicationEventPublisher
import java.util.Base64
import java.util.UUID

class CentralProtocolResourcesTest {
    private val identity = CentralResourceIdentity("https://central.example", "alice")
    private val workspace = mock(WorkspaceService::class.java)
    private val protocols = mock(ProtocolService::class.java)
    private val registry = mock(TransformRegistry::class.java)
    private val controller = CentralProtocolController(workspace, protocols, registry)

    private fun approved() {
        `when`(workspace.currentUsername()).thenReturn("alice")
        `when`(workspace.isApproved("alice")).thenReturn(true)
    }

    @Test fun `코덱 예외에는 전달한 원문이나 시크릿 파라미터를 노출하지 않는다`() {
        approved()
        val codec = object : FieldCodec {
            override fun id() = "throwing"
            override fun encode(value: String, ctx: CodecCtx): String = throw IllegalStateException("$value ${ctx.config["secret"]}")
            override fun decode(value: String, ctx: CodecCtx) = encode(value, ctx)
        }
        `when`(registry.codec("throwing", null)).thenReturn(codec)
        `when`(registry.fingerprint("throwing", null)).thenReturn("v1")
        val request = CentralCodecRequest("throwing", "encode", "v1", value = "private-body",
            field = FieldInfo("value", 20, "string", " "), config = mapOf("secret" to "private-secret"), direction = "send")
        assertThatThrownBy { controller.invoke(request, "pc") }.isInstanceOf(BadRequestException::class.java)
            .hasMessageContaining("서버 코덱 실행").hasMessageNotContaining("private-body").hasMessageNotContaining("private-secret")
    }

    @Test fun `전문 snapshot은 HTTP JSON과 호스트 mapper 차이를 견디고 PC가 바뀐 metadata를 거부한다`() {
        approved()
        val serverMapper = jacksonObjectMapper().configure(com.fasterxml.jackson.databind.SerializationFeature.INDENT_OUTPUT, true)
            .configure(com.fasterxml.jackson.databind.MapperFeature.SORT_PROPERTIES_ALPHABETICALLY, false)
            .setSerializationInclusion(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
        val json = JsonService(serverMapper)
        val pcMapper = jacksonObjectMapper().configure(com.fasterxml.jackson.databind.MapperFeature.SORT_PROPERTIES_ALPHABETICALLY, true)
        val pcJson = JsonService(pcMapper)
        val repo = mock(ProtocolRepository::class.java)
        val resourceWorkspace = mock(ResourceWorkspace::class.java)
        `when`(resourceWorkspace.key(null)).thenReturn("public")
        val spec = ProtocolSpec(encoding = "UTF-8", lengthField = "length", includesSelf = true,
            header = listOf(ProtocolSpec.Field("length", 4, "length")),
            messages = listOf(ProtocolSpec.Message("request", fields = listOf(ProtocolSpec.Field("value", 4, "string", plugin = ProtocolSpec.PluginRef("field"))))))
        val row = com.flowlink.core.domain.Protocol.create("default", "wire", json.mapper().writeValueAsString(spec)).also { it.workspaceKey = "public" }
        `when`(repo.findByIdAndTenantId(row.id, "default")).thenReturn(java.util.Optional.of(row))
        val v1 = mock(FieldCodec::class.java)
        `when`(v1.label()).thenReturn("field")
        val v2 = mock(FieldCodec::class.java)
        `when`(v2.label()).thenReturn("field")
        `when`(registry.codec("field", null)).thenReturn(v1)
        `when`(registry.fingerprint("field", null)).thenReturn("v1")
        val service = ProtocolService(repo, json, workspace, registry, mock(MockSecretProvider::class.java),
            mock(ApplicationEventPublisher::class.java), resourceWorkspace)
        val snapshot = service.snapshot(row.id.toString(), null, null)
        val expected = service.fingerprint(row.id.toString(), null)
        val remote = CentralProtocolController(workspace, service, registry).snapshot(row.id.toString(), "pc").body!!
        val transported = pcMapper.readValue(serverMapper.writeValueAsBytes(remote), CentralProtocolSnapshot::class.java)
        assertThat(transported.spec).isEqualTo(remote.spec)
        assertThat(snapshot.fingerprint).isEqualTo(expected)
        assertThat(remote.fingerprint).isEqualTo(expected)
        assertThat(snapshot.plugins.find("field")).isSameAs(v1)
        // snapshot을 만든 후 저장 정의와 승인 구현이 모두 바뀐다.
        row.specJson = json.mapper().writeValueAsString(spec.copy(encoding = "EUC-KR"))
        `when`(registry.codec("field", null)).thenReturn(v2)
        `when`(registry.fingerprint("field", null)).thenReturn("v2")
        assertThat(service.fingerprint(row.id.toString(), null)).isNotEqualTo(expected)
        assertThat(snapshot.spec.encoding).isEqualTo("UTF-8")
        assertThat(snapshot.plugins.find("field")).isSameAs(v1)
        assertThat(snapshot.fingerprint).isEqualTo(expected)

        val server = mock(LocalServerResources::class.java)
        @Suppress("UNCHECKED_CAST")
        val provider = mock(ObjectProvider::class.java) as ObjectProvider<LocalServerResources>
        `when`(provider.ifAvailable).thenReturn(server)
        `when`(workspace.localRuntime).thenReturn(true)
        val pc = ProtocolService(repo, pcJson, workspace, registry, mock(MockSecretProvider::class.java),
            mock(ApplicationEventPublisher::class.java), resourceWorkspace, provider)
        `when`(server.protocolSnapshot("wire", identity)).thenReturn(transported)
        assertThat(pc.snapshot("wire", null, identity).fingerprint).isEqualTo(expected)
        verify(server, never()).codecs(identity)
        // 이전 hash와 새 정의를 섞은 응답은 실제 encode 이전에 거부한다.
        `when`(server.protocolSnapshot("wire", identity)).thenReturn(CentralProtocolSnapshot(remote.spec.copy(encoding = "EUC-KR"), remote.codecs, remote.fingerprint))
        assertThatThrownBy { pc.snapshot("wire", null, identity) }.hasMessageContaining("버전 응답이 일치하지")
        `when`(server.protocolSnapshot("wire", identity)).thenReturn(transported.copy(codecs = transported.codecs.map { it.copy(fingerprint = "wrong-approved-version") }))
        assertThatThrownBy { pc.snapshot("wire", null, identity) }.hasMessageContaining("버전 응답이 일치하지")
    }

    @Test fun `중앙 field와 message 코덱은 실제 값을 양방향으로 전달하고 승인 버전을 고정한다`() {
        approved()
        val field = object : FieldCodec {
            override fun id() = "field"
            override fun encode(value: String, ctx: CodecCtx) = ctx.config.getValue("secret") + ":" + value
            override fun decode(value: String, ctx: CodecCtx) = value.removePrefix(ctx.config.getValue("secret") + ":")
        }
        val message = object : MessageCodec {
            override fun id() = "message"
            override fun encode(body: ByteArray, ctx: CodecCtx) = body.map { (it.toInt() xor ctx.config.getValue("key").toInt()).toByte() }.toByteArray()
            override fun decode(body: ByteArray, ctx: CodecCtx) = encode(body, ctx)
        }
        `when`(registry.codecs(null)).thenReturn(listOf(field, message))
        `when`(registry.codec("field", null)).thenReturn(field)
        `when`(registry.codec("message", null)).thenReturn(message)
        `when`(registry.fingerprint("field", null)).thenReturn("field-v1")
        `when`(registry.fingerprint("message", null)).thenReturn("message-v1")
        val calls = mutableListOf<CentralCodecRequest>()
        val bridge = object : LocalServerResources {
            override fun codecs(identity: CentralResourceIdentity): List<CentralCodecDescriptor> {
                assertThat(identity).isEqualTo(this@CentralProtocolResourcesTest.identity)
                return controller.codecs("pc").body!!
            }
            override fun codec(request: CentralCodecRequest, identity: CentralResourceIdentity) = controller.invoke(request, "pc").also {
                assertThat(it.headers.cacheControl).isEqualTo("no-store")
                calls += request
            }.body!!
        }
        val lookup = CentralProtocolCodecs(bridge, identity).lookup()
        val fieldProxy = lookup.find("field") as FieldCodec
        val context = CodecCtx(FieldInfo("account", 100, "string", "none"), mapOf("kind" to "request"), mapOf("secret" to "secret-plain"), "send")
        val encoded = fieldProxy.encode("1234", context)
        assertThat(encoded).isEqualTo("secret-plain:1234")
        assertThat(fieldProxy.decode(encoded, CodecCtx(context.field, context.message, context.config, "recv"))).isEqualTo("1234")
        val messageProxy = lookup.find("message") as MessageCodec
        val raw = byteArrayOf(0, 1, 127, -1, -128)
        val messageCtx = CodecCtx(null, emptyMap(), mapOf("key" to "17"), "send")
        val wire = messageProxy.encode(raw, messageCtx)
        assertThat(wire).isNotEqualTo(raw)
        assertThat(messageProxy.decode(wire, CodecCtx(null, emptyMap(), messageCtx.config, "recv"))).isEqualTo(raw)
        assertThat(calls.map { it.operation }).containsExactly("encode", "decode", "encode", "decode")
        assertThat(calls.last().bytesBase64).isEqualTo(Base64.getEncoder().encodeToString(wire))
        `when`(registry.fingerprint("field", null)).thenReturn("field-v2")
        assertThatThrownBy { fieldProxy.encode("1234", context) }.isInstanceOf(BadRequestException::class.java).hasMessageContaining("승인 버전")
    }

    @Test fun `중앙 RPC는 승인 공용 쓰기 권한과 PC 식별자를 요구한다`() {
        assertThatThrownBy { controller.codecs("pc") }.isInstanceOf(ForbiddenException::class.java)
        approved()
        assertThatThrownBy { controller.codecs(null) }.isInstanceOf(BadRequestException::class.java)
        doThrow(ForbiddenException("viewer")).`when`(workspace).requireWrite("alice", null)
        assertThatThrownBy { controller.codecs("pc") }.isInstanceOf(ForbiddenException::class.java)
        verifyNoInteractions(registry)
    }

    @Test fun `잘못된 바이트와 코덱 층 입력은 플러그인 실행 전에 거부한다`() {
        approved()
        val codec = mock(MessageCodec::class.java)
        `when`(registry.codec("message", null)).thenReturn(codec)
        `when`(registry.fingerprint("message", null)).thenReturn("v1")
        assertThatThrownBy { controller.invoke(CentralCodecRequest("message", "encode", "v1", bytesBase64 = "???", direction = "send"), "pc") }
            .isInstanceOf(BadRequestException::class.java)
        assertThatThrownBy { controller.invoke(CentralCodecRequest("message", "encode", "v1", value = "plain", bytesBase64 = "AA==", direction = "send"), "pc") }
            .isInstanceOf(BadRequestException::class.java)
        verifyNoInteractions(codec)
    }

    @Test fun `PC 명시 중앙 identity만 서버 정의를 조회하고 기존 개인과 팀은 기존 저장소를 유지한다`() {
        val localWorkspace = mock(WorkspaceService::class.java)
        `when`(localWorkspace.localRuntime).thenReturn(true)
        val repo = mock(ProtocolRepository::class.java)
        val resources = mock(LocalServerResources::class.java)
        @Suppress("UNCHECKED_CAST")
        val provider = mock(ObjectProvider::class.java) as ObjectProvider<LocalServerResources>
        `when`(provider.ifAvailable).thenReturn(resources)
        val service = ProtocolService(repo, JsonService(jacksonObjectMapper()), localWorkspace, registry,
            mock(MockSecretProvider::class.java), mock(ApplicationEventPublisher::class.java), mock(ResourceWorkspace::class.java), provider)
        val spec = ProtocolSpec(encoding = "UTF-8")
        `when`(resources.protocolSpec("public-wire", identity)).thenReturn(spec)
        `when`(resources.protocolFingerprint("public-wire", identity)).thenReturn("version")
        assertThat(service.spec("public-wire", null, identity)).isSameAs(spec)
        assertThat(service.fingerprint("public-wire", null, identity)).isEqualTo("version")
        verifyNoInteractions(repo)
        val team = UUID.randomUUID()
        service.plugins(team, identity).find("codec")
        service.plugins(null, null).find("codec")
        verify(registry).codec("codec", team)
        verify(registry).codec("codec", null)
        verify(resources, never()).codecs(identity)
    }
}
