package com.flowlink.core.repository

import com.flowlink.core.domain.AppUser
import com.flowlink.core.domain.Workspace
import com.flowlink.core.domain.WorkspaceMember
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface WorkspaceRepository : JpaRepository<Workspace, UUID> {
    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<Workspace>
    fun findByTenantIdOrderByCreatedAtAsc(tenantId: String): List<Workspace>
    fun findByTenantIdAndKindAndOwnerUsername(tenantId: String, kind: String, ownerUsername: String): Optional<Workspace>
}

interface WorkspaceMemberRepository : JpaRepository<WorkspaceMember, UUID> {
    fun findByWorkspaceIdOrderByCreatedAtAsc(workspaceId: UUID): List<WorkspaceMember>
    fun findByWorkspaceIdIn(workspaceIds: Collection<UUID>): List<WorkspaceMember> // 관리 콘솔 일괄 조회(N+1 제거)
    fun findByUsername(username: String): List<WorkspaceMember>
    fun findByWorkspaceIdAndUsername(workspaceId: UUID, username: String): Optional<WorkspaceMember>
    fun deleteByWorkspaceId(workspaceId: UUID)
}

interface AppUserRepository : JpaRepository<AppUser, UUID> {
    fun findByTenantIdAndUsername(tenantId: String, username: String): Optional<AppUser>
    fun findByTenantIdOrderByUsernameAsc(tenantId: String): List<AppUser>
}
