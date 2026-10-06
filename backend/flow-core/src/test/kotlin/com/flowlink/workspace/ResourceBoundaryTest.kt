package com.flowlink.workspace

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.core.domain.AppUser
import com.flowlink.core.domain.WorkspaceMember
import com.flowlink.core.repository.AppUserRepository
import com.flowlink.environment.EnvironmentService
import com.flowlink.mock.*
import com.flowlink.plugin.PluginScriptDtos
import com.flowlink.plugin.PluginScriptService
import com.flowlink.protocol.ProtocolService
import com.flowlink.secret.SecretService
import com.flowlink.transform.TransformRegistry
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.test.context.TestPropertySource
import java.util.UUID

@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:resource-boundary;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop", "flowlink.mock.tcp.port-start=19730", "flowlink.mock.tcp.port-end=19739",
])
class ResourceBoundaryTest {
    @Autowired lateinit var ws: WorkspaceService
    @Autowired lateinit var users: AppUserRepository
    @Autowired lateinit var environments: EnvironmentService
    @Autowired lateinit var secrets: SecretService
    @Autowired lateinit var protocols: ProtocolService
    @Autowired lateinit var scripts: PluginScriptService
    @Autowired lateinit var registry: TransformRegistry
    @Autowired lateinit var mocks: MockServerService
    @Autowired lateinit var gateway: MockGatewayController
    @Autowired lateinit var tcp: TcpMockRegistry
    @Autowired lateinit var json: JsonService

    private val protocol = """{"encoding":"UTF-8","lengthField":"length","header":[{"name":"length","len":4,"type":"length"}],"messages":[{"key":"request","fields":[{"name":"answer","len":4,"type":"ascii"}]},{"key":"response","fields":[{"name":"answer","len":4,"type":"ascii"}]}]}"""
    private fun team() = ws.createTeam("격리-${UUID.randomUUID()}")
    private fun asUser(name: String) {
        val jwt = Jwt.withTokenValue("test").header("alg", "none").claim("preferred_username", name).subject(name).build()
        SecurityContextHolder.getContext().authentication = JwtAuthenticationToken(jwt)
    }
    @AfterEach fun clear() { SecurityContextHolder.clearContext() }

    @Test fun `같은 이름의 환경 시크릿 전문은 공간마다 다른 값이며 다른 팀 폴백이 없다`() {
        val a = team(); val b = team(); val aid = UUID.fromString(a.id); val bid = UUID.fromString(b.id)
        environments.put("dev", mapOf("marker" to "A"), a.id)
        environments.put("dev", mapOf("marker" to "B"), b.id)
        secrets.put("token", "a-secret", null, a.id)
        secrets.put("token", "b-secret", null, b.id)
        val pa = protocols.create("전문", json.readTree(protocol), a.id)
        val pb = protocols.create("전문", json.readTree(protocol), b.id)
        assertThat(environments.vars("dev", aid)).containsEntry("marker", "A")
        assertThat(environments.vars("dev", bid)).containsEntry("marker", "B")
        assertThat(secrets.activeSecrets(null, aid)).containsEntry("token", "a-secret")
        assertThat(secrets.activeSecrets(null, bid)).containsEntry("token", "b-secret")
        val preview = scripts.tryRun(PluginScriptDtos.TryRequest(source = "({id:'mask-preview',label:'시크릿 미리보기',apply(i){fl.log(i.input);return {result:i.input}}})", inputs = mapOf("input" to "{{token@secret}}")), a.id)
        assertThat(preview.outputs).containsEntry("result", "••••••")
        assertThat(preview.logs).containsExactly("••••••")
        val bytes = "한글시크릿".toByteArray(Charsets.UTF_8)
        assertThat(MockSecretProvider.Scope(mapOf("token" to "한글시크릿"), emptyMap()).maskBytes(bytes)).isEqualTo(ByteArray(bytes.size) { '*'.code.toByte() })
        assertThat(protocols.resolveId("전문", aid)).isEqualTo(pa.id)
        assertThat(protocols.resolveId("전문", bid)).isEqualTo(pb.id)
        assertThat(protocols.canonicalReference(pa.id.toString(), aid)).isEqualTo("전문")
        assertThat(protocols.fingerprint("전문", aid)).isEqualTo(protocols.fingerprint("전문", bid))
        assertThat(environments.exists("dev", aid)).isTrue()
        assertThat(environments.exists("missing", aid)).isFalse()
        assertThrows<NotFoundException> { protocols.specOf(pa.id, workspaceId = bid) }
        assertThrows<BadRequestException> { ws.delete(aid, bid) }

        asUser("outsider")
        assertThrows<ForbiddenException> { environments.list(a.id) }
        assertThrows<ForbiddenException> { secrets.listNames(a.id) }
        assertThrows<ForbiddenException> { protocols.get(pa.id) }
        assertThrows<ForbiddenException> { scripts.list(a.id) }
        assertThrows<ForbiddenException> { environments.put("dev", mapOf("marker" to "leak"), a.id) }
    }

    @Test fun `승인 스크립트의 같은 id도 공간별 구현으로 실행하고 공용으로 새지 않는다`() {
        val a = team(); val b = team()
        fun source(value: String) = "({ id:'boundary-plugin', label:'공간검증', apply(){ return {result:'$value'} } })"
        val sa = scripts.create(PluginScriptDtos.SaveRequest("변환", source("A"), a.id))
        val sb = scripts.create(PluginScriptDtos.SaveRequest("변환", source("B"), b.id))
        scripts.submit(sa.id); scripts.submit(sb.id); scripts.approve(sa.id); scripts.approve(sb.id)
        assertThat(registry.get("boundary-plugin", UUID.fromString(a.id)).get().apply(emptyMap(), emptyMap())).containsEntry("result", "A")
        assertThat(registry.get("boundary-plugin", UUID.fromString(b.id)).get().apply(emptyMap(), emptyMap())).containsEntry("result", "B")
        assertThat(registry.get("boundary-plugin")).isEmpty
        assertThat(registry.fingerprint("boundary-plugin", UUID.fromString(a.id))).hasSize(64).isNotEqualTo(registry.fingerprint("boundary-plugin", UUID.fromString(b.id)))

        val viewer = users.save(AppUser.of("default", "scope-viewer", AppUser.STATUS_APPROVED))
        ws.putMember(UUID.fromString(a.id), viewer.username, WorkspaceMember.ROLE_VIEWER)
        asUser(viewer.username)
        assertThat(scripts.get(sa.id).workspaceId).isEqualTo(a.id)
        assertThrows<ForbiddenException> { scripts.update(sa.id, PluginScriptDtos.SaveRequest(source = source("changed"))) }
        assertThrows<ForbiddenException> { scripts.get(sb.id) }
    }

    @Test fun `같은 slug는 팀 경로와 환경으로 분리되고 레거시 경로가 팀 내용을 노출하지 않는다`() {
        val a = team(); val b = team()
        environments.put("stage", mapOf("marker" to "A"), a.id)
        environments.put("stage", mapOf("marker" to "B"), b.id)
        val ma = mocks.create(MockDtos.CreateMockServerRequest("A", "shared-orders", "HTTP", a.id))
        val mb = mocks.create(MockDtos.CreateMockServerRequest("B", "shared-orders", "HTTP", b.id))
        val spec = json.readTree("""{"environment":"stage","routes":[{"method":"GET","path":"/origin","rules":[{"status":200,"contentType":"text","body":"{{marker@env}}"}]}]}""")
        mocks.updateSpec(ma.id, spec); mocks.updateSpec(mb.id, spec)
        fun call(path: String) = gateway.handle("ws", MockHttpServletRequest("GET", path))
        assertThat(String(call(ma.basePath + "/origin").body!!)).isEqualTo("A")
        assertThat(String(call(mb.basePath + "/origin").body!!)).isEqualTo("B")
        assertThat(call("/mock/shared-orders/origin").statusCode.value()).isEqualTo(404)
        assertThat(ma.listener!!.agent).isEqualTo("server")
        assertThat(ma.listener!!.state).isEqualTo("LISTENING")
        val origin = "http://" + java.net.URI(mocks.resolveAgentTarget(ma.slug, UUID.fromString(a.id)).baseUrl).rawAuthority
        val oldUrl = "$origin/mock/shared-orders/origin?value=%2F"
        assertThat(mocks.normalizeLegacyUrl(oldUrl, UUID.fromString(a.id))).isEqualTo(origin + ma.basePath + "/origin?value=%2F")
        assertThat(mocks.normalizeLegacyUrl(oldUrl, UUID.fromString(b.id))).isEqualTo(origin + mb.basePath + "/origin?value=%2F")
        assertThat(mocks.normalizeLegacyUrl("$origin/mock/default/shared-orders/origin", UUID.fromString(a.id))).isEqualTo(origin + ma.basePath + "/origin")
        val externalUrl = "https://external.example/mock/shared-orders/origin"
        assertThat(mocks.normalizeLegacyUrl(externalUrl, UUID.fromString(a.id))).isEqualTo(externalUrl)
        val otherPort = "http://127.0.0.1:19799/mock/shared-orders/origin"
        assertThat(mocks.normalizeLegacyUrl(otherPort, UUID.fromString(a.id))).isEqualTo(otherPort)
        assertThrows<BadRequestException> { mocks.create(MockDtos.CreateMockServerRequest("중복", "shared-orders", "HTTP", a.id)) }
    }

    @Test fun `TCP는 허용 포트의 실제 소켓과 일치하고 포트 중복 및 다른 공간 전문을 거절한다`() {
        val a = team(); val b = team()
        val proto = protocols.create("TCP", json.readTree(protocol), a.id)
        val ma = mocks.create(MockDtos.CreateMockServerRequest("A", "scoped-tcp-a", "TCP", a.id))
        val mb = mocks.create(MockDtos.CreateMockServerRequest("B", "scoped-tcp-b", "TCP", b.id))
        val port = ma.spec.path("tcp").path("port").asInt()
        fun spec(p: Int) = json.readTree("""{"tcp":{"port":$p,"protocolId":"${proto.id}","rules":[{"id":"ok","when":[],"then":{"mode":"mock","fields":{"answer":"OKAY"}}}]}}""")
        try {
            val started = mocks.updateSpec(ma.id, spec(port))
            assertThat(started.listener!!.state).isEqualTo("LISTENING")
            assertThat(tcp.listeningPort(ma.id)).isEqualTo(port)
            assertThat(mocks.tcpSend(ma.id, MockDtos.TcpSendRequest("request", mapOf("answer" to "PING"))).response.body).containsEntry("answer", "OKAY")
            assertThrows<BadRequestException> { mocks.updateSpec(ma.id, spec(19740)) }
            assertThrows<BadRequestException> { mocks.updateSpec(mb.id, spec(port)) }
            assertThrows<BadRequestException> { mocks.updateSpec(mb.id, spec(mb.spec.path("tcp").path("port").asInt())) }
            mocks.updateMeta(ma.id, MockDtos.UpdateMockServerRequest(null, false))
            assertThat(tcp.listeningPort(ma.id)).isNull()
            assertThat(mocks.get(ma.id).listener!!.state).isEqualTo("OFF")
        } finally { mocks.delete(ma.id); mocks.delete(mb.id) }
    }
}
