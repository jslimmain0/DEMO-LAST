package com.flowlink.core.repository

import com.flowlink.core.domain.Flow
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.util.Optional
import java.util.UUID

interface FlowRepository : JpaRepository<Flow, UUID> {

    fun findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(tenantId: String): List<Flow>

    // 워크스페이스 스코프 목록 — null=공용(레거시 데이터 포함)
    fun findByTenantIdAndArchivedFalseAndWorkspaceIdIsNullOrderByUpdatedAtDesc(tenantId: String): List<Flow>
    fun findByTenantIdAndArchivedFalseAndWorkspaceIdOrderByUpdatedAtDesc(tenantId: String, workspaceId: UUID): List<Flow>

    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<Flow>

    fun countByTenantIdAndFolderIdAndArchivedFalse(tenantId: String, folderId: UUID): Long

    /** 폴더 직속 워크플로 — 스위트 일괄 실행용(하위 폴더 재귀 아님). */
    fun findByTenantIdAndFolderIdAndArchivedFalse(tenantId: String, folderId: UUID): List<Flow>

    /** 폴더 삭제 시 안의 워크플로를 상위 폴더로(루트 폴더 삭제면 toId=null → 미분류). */
    @Modifying
    @Query("update Flow f set f.folderId = :toId where f.folderId = :fromId")
    fun reassignFolder(@Param("fromId") fromId: UUID, @Param("toId") toId: UUID?): Int

    /** 워크스페이스 삭제 시 안의 워크플로를 공용(null)으로 승격 — 데이터 유실 방지. */
    @Modifying
    @Query("update Flow f set f.workspaceId = null where f.workspaceId = :wsId")
    fun clearWorkspace(@Param("wsId") wsId: UUID): Int
}
