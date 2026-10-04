package com.flowlink.core.repository

import com.flowlink.core.domain.Protocol
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface ProtocolRepository : JpaRepository<Protocol, UUID> {
    fun countByTenantIdAndWorkspaceKey(tenantId: String, workspaceKey: String): Long
    fun findByTenantIdAndWorkspaceKeyOrderByNameAsc(tenantId: String, workspaceKey: String): List<Protocol>
    fun existsByTenantIdAndWorkspaceKeyAndName(tenantId: String, workspaceKey: String, name: String): Boolean

    fun findByTenantIdOrderByNameAsc(tenantId: String): List<Protocol>
    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<Protocol>
    fun existsByTenantIdAndName(tenantId: String, name: String): Boolean
}
