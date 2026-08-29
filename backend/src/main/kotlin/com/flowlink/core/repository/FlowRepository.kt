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

    // 관리 콘솔 — 워크스페이스별 워크플로 수
    fun countByTenantIdAndArchivedFalseAndWorkspaceId(tenantId: String, workspaceId: UUID): Long
    fun countByTenantIdAndArchivedFalseAndWorkspaceIdIsNull(tenantId: String): Long

    /** 폴더별 워크플로 수 일괄(group by) — 폴더 목록의 폴더당 count 쿼리 N+1 제거. */
    @Query("SELECT f.folderId, COUNT(f) FROM Flow f WHERE f.tenantId = :tenant AND f.archived = false AND f.folderId IS NOT NULL GROUP BY f.folderId")
    fun countGroupByFolder(@Param("tenant") tenant: String): List<Array<Any>>

    /** 워크스페이스별 워크플로 수 일괄(group by) — 관리 콘솔의 ws 당 count N+1 제거. */
    @Query("SELECT f.workspaceId, COUNT(f) FROM Flow f WHERE f.tenantId = :tenant AND f.archived = false AND f.workspaceId IS NOT NULL GROUP BY f.workspaceId")
    fun countGroupByWorkspace(@Param("tenant") tenant: String): List<Array<Any>>

    /** 폴더 직속 워크플로 — 스위트 일괄 실행용(하위 폴더 재귀 아님). */
    fun findByTenantIdAndFolderIdAndArchivedFalse(tenantId: String, folderId: UUID): List<Flow>

    /** 폴더 삭제 시 안의 워크플로를 상위 폴더로(루트 폴더 삭제면 toId=null → 미분류). */
    @Modifying
    @Query("update Flow f set f.folderId = :toId where f.folderId = :fromId")
    fun reassignFolder(@Param("fromId") fromId: UUID, @Param("toId") toId: UUID?): Int

    /** 워크스페이스 삭제 시 안의 워크플로 이관 — to=삭제 실행자의 개인 ws(비공개 유지), null=공용 폴백. */
    @Modifying
    @Query("update Flow f set f.workspaceId = :to where f.workspaceId = :from")
    fun reassignWorkspace(@Param("from") from: UUID, @Param("to") to: UUID?): Int
}
