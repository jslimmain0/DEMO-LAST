package com.flowlink.mock

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.MockServer
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.protocol.ProtocolDtos
import com.flowlink.workspace.WorkspaceService
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import java.util.Optional
import java.util.UUID

class MockTrialStoreTest {
    @Test fun `oversized retained trial omits body without changing caller response`() {
        val workspace = mock(WorkspaceService::class.java)
        val repo = mock(MockServerRepository::class.java)
        val row = MockServer.create(TenantContext.getTenantId(), "synthetic", "trial", MockServer.Kind.TCP, "{}")
        `when`(workspace.currentUsername()).thenReturn("tester")
        `when`(repo.findByIdAndTenantId(row.id, TenantContext.getTenantId())).thenReturn(Optional.of(row))
        val store = MockTrialStore(workspace, repo, JsonService(jacksonObjectMapper().findAndRegisterModules()))
        val id = UUID.randomUUID()
        store.start(id, null, row.id, 3, "snapshot")
        val body = "x".repeat(32 * 1024 * 1024)
        val response = MockDtos.TcpSendResult(ProtocolDtos.PreviewResult(0, "", "", emptyList(), emptyList()),
            MockDtos.DecodedView(null, null, emptyMap(), emptyMap(), body, "", body.length, emptyList(), false, emptyList()), 1)
        store.complete(id, response)
        val kept = store.get(id)!!
        assertEquals(true, kept["contentTruncated"])
        assertTrue((kept["warnings"] as List<*>).single().toString().contains("32MB"))
        assertEquals(body.length, response.response.text.length)
        assertEquals(mapOf("wireLength" to body.length), kept["response"])
        verify(workspace, atLeastOnce()).requireRead("tester", null)
    }
}
