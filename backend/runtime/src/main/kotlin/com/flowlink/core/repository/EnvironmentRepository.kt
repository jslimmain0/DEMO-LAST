package com.flowlink.core.repository

import com.flowlink.core.domain.Environment
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface EnvironmentRepository : JpaRepository<Environment, UUID> {
    fun countByTenantIdAndWorkspaceKey(tenantId: String, workspaceKey: String): Long
    fun findByTenantIdAndWorkspaceKeyOrderByNameAsc(tenantId: String, workspaceKey: String): List<Environment>
    fun findByTenantIdAndWorkspaceKeyAndName(tenantId: String, workspaceKey: String, name: String): Optional<Environment>


    fun findByTenantIdOrderByNameAsc(tenantId: String): List<Environment>

    fun findByTenantIdAndName(tenantId: String, name: String): Optional<Environment>
}
