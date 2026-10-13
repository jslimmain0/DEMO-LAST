package com.flowlink.mock

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.MockServer
import com.flowlink.core.repository.*
import com.flowlink.protocol.ProtocolService
import com.flowlink.transform.TransformRegistry
import com.flowlink.workspace.ResourceWorkspace
import com.flowlink.workspace.WorkspaceService
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.mockito.Mockito.*
import org.springframework.core.env.Environment
import java.time.Instant
import java.util.Optional
import java.util.UUID

class MockTcpSessionAccessTest {
    private val repo = mock(MockServerRepository::class.java)
    private val registry = mock(TcpMockRegistry::class.java)
    private val workspace = mock(WorkspaceService::class.java)
    private val owner = UUID.randomUUID()
    private val mockServer = MockServer.create(TenantContext.getTenantId(), "TCP", "sessions", MockServer.Kind.TCP,
        """{"tcp":{"port":9091,"rules":[]}}""").apply { workspaceId = owner }
    private val now = Instant.now()
    private val view = TcpMockListenerRuntime.SessionView(id = UUID.randomUUID(), remoteAddress = "127.0.0.1", remotePort = 50000,
        connectedAt = now, lastActivityAt = now, idleTimeoutMs = 30000, state = "waiting", expiresAt = now.plusSeconds(30),
        remainingMs = 30000, receivedMessages = 1)
    private val service = MockServerService(repo, JsonService(jacksonObjectMapper()), registry, mock(MockRuntimeStore::class.java),
        workspace, mock(MockSecretProvider::class.java), mock(TransformRegistry::class.java), mock(MockServerVersionRepository::class.java),
        mock(FlowRepository::class.java), mock(FlowVersionRepository::class.java), mock(ProtocolService::class.java),
        mock(ProtocolRepository::class.java), mock(Environment::class.java), mock(ResourceWorkspace::class.java))

    init {
        `when`(workspace.currentUsername()).thenReturn("viewer")
        `when`(repo.findByIdAndTenantId(mockServer.id, TenantContext.getTenantId())).thenReturn(Optional.of(mockServer))
        `when`(registry.sessions(mockServer.id)).thenReturn(listOf(view))
        `when`(registry.extendSession(mockServer.id, view.id, 60000)).thenReturn(view.copy(remainingMs = 90000, expiresAt = now.plusSeconds(90)))
    }

    @AfterEach fun clearTenant() = TenantContext.clear()

    @Test fun `viewer can inspect sessions but cannot extend them`() {
        doThrow(ForbiddenException("읽기 전용")).`when`(workspace).requireWrite("viewer", owner)
        assertThat(service.tcpSessions(mockServer.id)).containsExactly(view)
        verify(workspace).requireRead("viewer", owner)
        assertThrows<ForbiddenException> { service.extendTcpSession(mockServer.id, view.id, 60000) }
        verify(registry, never()).extendSession(mockServer.id, view.id, 60000)
    }

    @Test fun `unreadable or other tenant sessions never reach runtime`() {
        doThrow(ForbiddenException("접근 불가")).`when`(workspace).requireRead("viewer", owner)
        assertThrows<ForbiddenException> { service.tcpSessions(mockServer.id) }
        TenantContext.setTenantId("other-tenant")
        `when`(repo.findByIdAndTenantId(mockServer.id, "other-tenant")).thenReturn(Optional.empty())
        assertThrows<NotFoundException> { service.tcpSessions(mockServer.id) }
        assertThrows<NotFoundException> { service.extendTcpSession(mockServer.id, view.id, 60000) }
        verifyNoInteractions(registry)
    }

    @Test fun `writer extends only the selected session without saving definitions`() {
        val result = service.extendTcpSession(mockServer.id, view.id, 60000)
        assertThat(result.remainingMs).isEqualTo(90000)
        verify(workspace).requireWrite("viewer", owner)
        verify(registry).extendSession(mockServer.id, view.id, 60000)
        verify(repo, never()).save(any(MockServer::class.java))
    }

    @Test fun `invalid durations and HTTP Mock cannot alter session deadlines`() {
        for (ms in listOf(0, -1, 999, 3600001)) assertThrows<BadRequestException> { service.extendTcpSession(mockServer.id, view.id, ms) }
        mockServer.specJson = """{"routes":[]}"""
        assertThrows<BadRequestException> { service.tcpSessions(mockServer.id) }
        assertThrows<BadRequestException> { service.extendTcpSession(mockServer.id, view.id, 60000) }
        verifyNoInteractions(registry)
    }
}
