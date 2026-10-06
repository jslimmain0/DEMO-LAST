package com.flowlink.mock

import com.flowlink.core.domain.MockServer
import org.springframework.stereotype.Component

fun MockServer.servingSnapshot() = MockServingSnapshot(id, tenantId, workspaceId, slug, specJson, isEnabled)
@Component
class ManagedMockServingLookup(private val service: MockServerService) : MockServingLookup {
    override fun findForServingWorkspace(workspace: String, slug: String) = service.findForServingWorkspace(workspace, slug).orElse(null)?.servingSnapshot()
    override fun findForServing(tenant: String, slug: String) = service.findForServing(tenant, slug).orElse(null)?.servingSnapshot()
}
