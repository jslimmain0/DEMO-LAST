package com.flowlink.mock

import java.util.UUID

data class MockServingSnapshot(val id: UUID, val tenantId: String, val workspaceId: UUID?, val slug: String, val specJson: String?, val isEnabled: Boolean)
interface MockServingLookup {
    fun findForServingWorkspace(workspace: String, slug: String): MockServingSnapshot?
    fun findForServing(tenant: String, slug: String): MockServingSnapshot?
}
