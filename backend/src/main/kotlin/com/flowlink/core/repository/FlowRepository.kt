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

    @Modifying
    @Query("update Flow f set f.folderId = null where f.folderId = :folderId")
    fun clearFolder(@Param("folderId") folderId: UUID): Int
}
