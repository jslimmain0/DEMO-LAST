package com.flowlink.mock

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.agent.CentralResourceIdentity
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.host.*
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.environment.EnvironmentService
import com.flowlink.protocol.*
import com.flowlink.secret.SecretService
import com.flowlink.transform.FlowTransform
import com.flowlink.workspace.WorkspaceService
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.mockito.Mockito.*
import org.springframework.beans.factory.ObjectProvider
import java.util.UUID

class CentralMockScopeLoaderTest {
    private val json = JsonService(jacksonObjectMapper())
    private val identity = CentralResourceIdentity("https://central.example", "alice")
    private val owner = UUID.randomUUID()
    private val secrets = mock(SecretService::class.java)
    private val environments = mock(EnvironmentService::class.java)
    private val workspace = mock(WorkspaceService::class.java)
    private val protocols = mock(ProtocolService::class.java)
    private var current = LocalServerIdentity(identity.serverUrl, identity.login, true)
    private val connection = object : LocalServerConnection { override fun connectionIdentity() = current }
    private val environmentCalls = mutableListOf<String?>()
    private val secretCalls = mutableListOf<Pair<String?, Set<String>>>()
    private val transformCalls = mutableListOf<CentralTransformRequest>()
    private val server = object : LocalServerResources {
        override fun environment(name: String?, identity: CentralResourceIdentity): Map<String, String> {
            assertThat(identity).isEqualTo(this@CentralMockScopeLoaderTest.identity)
            environmentCalls += name
            return mapOf("ORIGIN" to "server")
        }
        override fun secrets(name: String?, keys: Set<String>, identity: CentralResourceIdentity): Map<String, String> {
            assertThat(identity).isEqualTo(this@CentralMockScopeLoaderTest.identity)
            secretCalls += name to keys.toSet()
            return keys.associateWith { if (name == null) "common-$it" else "server-$name-$it" }
        }
        override fun transforms(identity: CentralResourceIdentity) = listOf(CentralTransformDescriptor("decorate", "꾸미기", "",
            listOf(FlowTransform.IoSpec.of("input", "입력")), listOf(FlowTransform.IoSpec.of("result", "출력")), emptyList(), "approved-v1"))
        override fun transform(request: CentralTransformRequest, identity: CentralResourceIdentity): CentralTransformResult {
            assertThat(identity).isEqualTo(this@CentralMockScopeLoaderTest.identity)
            transformCalls += request
            return CentralTransformResult(mapOf("result" to request.config.getValue("prefix") + request.inputs.getValue("input")))
        }
    }
    @Suppress("UNCHECKED_CAST")
    private fun <T : Any> provider(value: T): ObjectProvider<T> = (mock(ObjectProvider::class.java) as ObjectProvider<T>).also {
        `when`(it.getObject()).thenReturn(value)
        `when`(it.ifAvailable).thenReturn(value)
    }
    private fun loader(local: Boolean = true): ManagedMockScopeLoader {
        `when`(workspace.localRuntime).thenReturn(local)
        `when`(environments.exists("dev", owner)).thenReturn(true)
        `when`(environments.vars("dev", owner)).thenReturn(mapOf("ORIGIN" to "pc"))
        return ManagedMockScopeLoader(secrets, environments, workspace, provider(server), provider(protocols), json, provider(connection))
    }
    private fun spec(text: String = """{"routes":[{"rules":[{"body":"{{ TOKEN@secret }} {{ secret.EXTRA }}"}]}]}""") =
        json.mapper().readValue(text, MockSpec::class.java).copy(resourceWorkspaceId = "public", resourceIdentity = identity, envSource = "local", environment = "dev")

    @AfterEach fun clearTenant() = TenantContext.clear()

    @Test fun `PC and server environments with the same name never overlay each other implicitly`() {
        val loader = loader()
        TenantContext.setTenantId("previous")
        val pc = loader.load("tenant", "dev", owner, spec())
        assertThat(pc.env).containsEntry("ORIGIN", "pc")
        assertThat(pc.secrets).containsEntry("TOKEN", "common-TOKEN")
        assertThat(secretCalls).containsExactly(null to setOf("TOKEN", "EXTRA"))
        assertThat(environmentCalls).isEmpty()
        val remote = loader.load("tenant", "dev", owner, spec().copy(envSource = "server"))
        assertThat(remote.env).containsEntry("ORIGIN", "server")
        assertThat(remote.secrets).containsEntry("TOKEN", "server-dev-TOKEN")
        assertThat(secretCalls.last()).isEqualTo("dev" to setOf("TOKEN", "EXTRA"))
        assertThat(environmentCalls).containsExactly("dev")
        verifyNoInteractions(secrets)
        assertThat(TenantContext.getTenantId()).isEqualTo("previous")
    }

    @Test fun `pure local HTTP Mock is usable offline without a saved server identity or central RPC`() {
        val loader = loader()
        current = LocalServerIdentity("", null, false)
        val offline = spec("""{"routes":[{"rules":[{"body":"{{ ORIGIN@env }}"}]}]}""").copy(resourceIdentity = CentralResourceIdentity("", null))
        val scope = loader.load("tenant", "dev", owner, offline)
        scope.verifyAccess()
        assertThat(scope.resolver()("{{ ORIGIN@env }}")).isEqualTo("pc")
        assertThat(scope.secrets).isEmpty()
        assertThat(secretCalls).isEmpty()
        assertThat(environmentCalls).isEmpty()
        assertThat(transformCalls).isEmpty()
        verifyNoInteractions(secrets, protocols)
    }

    @Test fun `central Mock scopes bypass decrypted cache and an already open scope rejects another account`() {
        val provider = MockSecretProvider(loader())
        val first = provider.scope("tenant", "dev", workspaceId = owner, spec = spec())
        provider.scope("tenant", "dev", workspaceId = owner, spec = spec())
        assertThat(secretCalls).hasSize(2)
        current = current.copy(login = "bob")
        assertThrows<BadRequestException> { first.verifyAccess() }
        assertThrows<BadRequestException> { provider.scope("tenant", "dev", workspaceId = owner, spec = spec()) }
        current = current.copy(login = "alice", connected = false)
        assertThrows<BadRequestException> { first.verifyAccess() }
    }

    @Test fun `central protocol codec parameters join exact required secret keys and transform applies via pinned RPC`() {
        val loader = loader()
        val protocol = ProtocolSpec(header = listOf(ProtocolSpec.Field("value", 8, "string", plugin = ProtocolSpec.PluginRef("field", mapOf("iv" to "{{ IV@secret }}")))))
        `when`(protocols.snapshot("wire", null, identity)).thenReturn(ResolvedProtocol(protocol, ProtocolCodec.NO_PLUGINS, "wire-v1"))
        val active = spec().copy(tcp = MockSpec.MockTcp(9600, "wire"), codec = MockSpec.MockCodec(response = listOf(MockSpec.MockCodecStep("decorate"))))
        val scope = loader.load("tenant", "dev", owner, active)
        assertThat(scope.protocol).isSameAs(protocol)
        assertThat(scope.codecLookup).isSameAs(ProtocolCodec.NO_PLUGINS)
        assertThat(secretCalls).containsExactly(null to setOf("TOKEN", "EXTRA", "IV"))
        assertThat(scope.transformLookup!!.invoke("decorate")!!.apply(mapOf("input" to "actual wire"), mapOf("prefix" to "secret-prefix:")))
            .containsEntry("result", "secret-prefix:actual wire")
        assertThat(transformCalls).containsExactly(CentralTransformRequest("decorate", "approved-v1", mapOf("input" to "actual wire"), mapOf("prefix" to "secret-prefix:")))
        assertThat(scope.mask("common-IV common-TOKEN")).doesNotContain("common-IV", "common-TOKEN")
    }

    @Test fun `headless server Mock rejects PC source and uses public server environment instead of its team`() {
        val loader = loader(local = false)
        assertThrows<BadRequestException> { loader.load("tenant", "dev", owner, spec()) }
        verifyNoInteractions(secrets)
        `when`(environments.exists("dev", null)).thenReturn(true)
        `when`(environments.vars("dev", null)).thenReturn(mapOf("ORIGIN" to "server-public"))
        `when`(secrets.activeSecrets("dev", null)).thenReturn(mapOf("TOKEN" to "server-dev"))
        val scope = loader.load("tenant", "dev", owner, spec().copy(envSource = "server"))
        assertThat(scope.env).containsEntry("ORIGIN", "server-public")
        assertThat(scope.secrets).containsEntry("TOKEN", "server-dev")
        verify(environments, never()).vars("dev", owner)
        verify(secrets).activeSecrets("dev", null)
        assertThat(secretCalls).isEmpty()
    }

    @Test fun `legacy Mock JSON omits central fields and preserves original workspace semantics`() {
        val legacy = MockSpec(routes = emptyList())
        val text = json.toJson(legacy)
        assertThat(text).doesNotContain("resourceWorkspaceId", "resourceIdentity", "envSource")
        assertThat(json.mapper().readValue(text, MockSpec::class.java)).isEqualTo(legacy)
        val loader = loader()
        `when`(secrets.activeSecrets("dev", owner)).thenReturn(mapOf("TOKEN" to "legacy-personal"))
        val scope = loader.load("tenant", "dev", owner)
        assertThat(scope.secrets).containsEntry("TOKEN", "legacy-personal")
        assertThat(secretCalls).isEmpty()
    }
}
