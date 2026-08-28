package com.flowlink.core.repository

import com.flowlink.core.domain.Folder
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.util.Optional
import java.util.UUID

interface FolderRepository : JpaRepository<Folder, UUID> {

    fun findByTenantIdOrderByNameAsc(tenantId: String): List<Folder>

    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<Folder>

    /** 워크스페이스 삭제 시 안의 폴더를 공용(null)으로 승격. */
    @Modifying
    @Query("update Folder f set f.workspaceId = null where f.workspaceId = :wsId")
    fun clearWorkspace(@Param("wsId") wsId: UUID): Int
}
