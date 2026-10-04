package com.flowlink.core.repository

import com.flowlink.core.domain.PluginScript
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface PluginScriptRepository : JpaRepository<PluginScript, UUID> {
    fun countByTenantIdAndWorkspaceKey(tenantId: String, workspaceKey: String): Long
    fun findByTenantIdAndWorkspaceKeyOrderByUpdatedAtDesc(tenantId: String, workspaceKey: String): List<PluginScript>
    fun existsByTenantIdAndWorkspaceKeyAndPluginId(tenantId: String, workspaceKey: String, pluginId: String): Boolean

    fun findByTenantIdOrderByUpdatedAtDesc(tenantId: String): List<PluginScript>
    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<PluginScript>
    fun existsByTenantIdAndPluginId(tenantId: String, pluginId: String): Boolean
    /** 승인본이 있는 행 전부(전 테넌트) — 레지스트리 reload 용. */
    fun findByLiveSourceIsNotNull(): List<PluginScript>
    fun countByTenantIdAndStatus(tenantId: String, status: String): Long
}
