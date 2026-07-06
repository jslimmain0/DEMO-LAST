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

    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<Flow>

    fun countByTenantIdAndFolderIdAndArchivedFalse(tenantId: String, folderId: UUID): Long

    /** 폴더 삭제 시 안의 워크플로를 상위 폴더로(루트 폴더 삭제면 toId=null → 미분류). */
    @Modifying
    @Query("update Flow f set f.folderId = :toId where f.folderId = :fromId")
    fun reassignFolder(@Param("fromId") fromId: UUID, @Param("toId") toId: UUID?): Int
}
