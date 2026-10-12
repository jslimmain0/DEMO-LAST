package com.flowlink.plugin

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Flow
import com.flowlink.core.domain.FlowVersion
import com.flowlink.core.domain.MockServer
import com.flowlink.core.domain.PluginScript
import com.flowlink.core.domain.Protocol
import com.flowlink.core.repository.*
import com.flowlink.mock.MockSecretProvider
import com.flowlink.notify.NotificationService
import com.flowlink.plugin.script.ScriptRuntime
import com.flowlink.transform.TransformRegistry
import com.flowlink.workspace.ResourceWorkspace
import com.flowlink.workspace.WorkspaceService
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import java.util.Optional
import java.util.UUID

class PluginUsageScopeTest {
    @AfterEach fun clear() = TenantContext.clear()

    @Test fun `팀 문서의 명시 공통 자원은 public 삭제를 보호하고 접근 권한에 따라 사용처만 익명화한다`() {
        val tenant = "jwt-tenant"
        TenantContext.setTenantId(tenant)
        val owner = UUID.randomUUID()
        val plugin = "shared-codec"
        val flows = mock(FlowRepository::class.java)
        val versions = mock(FlowVersionRepository::class.java)
        val mocks = mock(MockServerRepository::class.java)
        val protocols = mock(ProtocolRepository::class.java)
        val workspace = mock(WorkspaceService::class.java)
        `when`(workspace.currentUsername()).thenReturn("alice")
        doThrow(ForbiddenException("private team")).`when`(workspace).requireRead("alice", owner)
        val sharedFlow = Flow.create(TenantContext.SHARED_FLOW_TENANT, "비공개 팀 흐름", null).also { it.workspaceId = owner }
        val legacyFlow = Flow.create(TenantContext.SHARED_FLOW_TENANT, "기존 팀 흐름", null).also { it.workspaceId = owner }
        `when`(flows.findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(TenantContext.SHARED_FLOW_TENANT)).thenReturn(listOf(sharedFlow, legacyFlow))
        val sharedGraph = """{"resourceWorkspaceId":"public","nodes":[{"id":"n","type":"transform","transformId":"$plugin"}]}"""
        val legacyGraph = """{"nodes":[{"id":"n","type":"transform","transformId":"$plugin"}]}"""
        `when`(versions.findCurrentByFlowIds(listOf(sharedFlow.id, legacyFlow.id))).thenReturn(listOf(
            FlowVersion.create(sharedFlow.id, 1, "current", sharedGraph, null, "dev"),
            FlowVersion.create(legacyFlow.id, 1, "current", legacyGraph, null, "dev")))
        val sharedMock = MockServer.create(tenant, "비공개 팀 Mock", "shared-mock", MockServer.Kind.HTTP,
            """{"resourceWorkspaceId":"public","routes":[{"codec":{"response":[{"id":"$plugin"}]}}]}""").also { it.workspaceId = owner }
        val legacyMock = MockServer.create(tenant, "기존 팀 Mock", "legacy-mock", MockServer.Kind.HTTP,
            """{"routes":[{"codec":{"response":[{"id":"$plugin"}]}}]}""").also { it.workspaceId = owner }
        `when`(mocks.findByTenantIdOrderByUpdatedAtDesc(tenant)).thenReturn(listOf(sharedMock, legacyMock))
        val publicProtocol = Protocol.create(tenant, "공통 메시지 전문", """{"messagePlugins":[{"id":"$plugin"}]}""")
        val teamProtocol = Protocol.create(tenant, "팀 메시지 전문", """{"messagePlugins":[{"id":"$plugin"}]}""").also { it.workspaceKey = owner.toString() }
        `when`(protocols.findByTenantIdOrderByNameAsc(tenant)).thenReturn(listOf(publicProtocol, teamProtocol))
        val index = PluginUsageIndex(flows, versions, mocks, protocols, JsonService(jacksonObjectMapper()), workspace)

        assertThat(index.count(plugin, "public")).isEqualTo(3)
        assertThat(index.count(plugin, owner.toString())).isEqualTo(3)
        verify(workspace, never()).requireRead("alice", owner)
        verify(flows).findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(TenantContext.SHARED_FLOW_TENANT)
        verify(flows, never()).findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(tenant)
        val hidden = index.refs(plugin)
        assertThat(hidden).contains(PluginUsageIndex.Ref("flow", "", "접근 권한 없는 워크플로"), PluginUsageIndex.Ref("mock", "", "접근 권한 없는 Mock"))
        assertThat(hidden.toString()).doesNotContain(sharedFlow.id.toString(), sharedMock.id.toString(), "비공개 팀")
        assertThat(hidden).contains(PluginUsageIndex.Ref("protocol", publicProtocol.id.toString(), publicProtocol.name))
        // 문서 cache에는 권한 결정을 저장하지 않는다. 계정/권한 변경은 새 요청에 즉시 적용한다.
        doNothing().`when`(workspace).requireRead("alice", owner)
        assertThat(index.refs(plugin)).contains(PluginUsageIndex.Ref("flow", sharedFlow.id.toString(), sharedFlow.name),
            PluginUsageIndex.Ref("mock", sharedMock.id.toString(), sharedMock.name))
        doThrow(ForbiddenException("private team")).`when`(workspace).requireRead("alice", owner)

        val scripts = mock(PluginScriptRepository::class.java)
        val row = PluginScript.create(tenant, plugin, "삭제 가드", "transform", "source", "alice")
        `when`(scripts.findByIdAndTenantId(row.id, tenant)).thenReturn(Optional.of(row))
        val service = PluginScriptService(scripts, mock(ScriptRuntime::class.java), workspace, mock(TransformRegistry::class.java), index,
            mock(NotificationService::class.java), mock(MockSecretProvider::class.java), mock(ResourceWorkspace::class.java))
        assertThatThrownBy { service.delete(row.id) }.isInstanceOf(BadRequestException::class.java).hasMessageContaining("사용처 3곳")
        verify(scripts, never()).delete(row)
    }
}
