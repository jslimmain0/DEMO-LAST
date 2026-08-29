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

    /** 워크스페이스 삭제 시 안의 폴더 이관 — to=삭제 실행자의 개인 ws(비공개 유지), null=공용 폴백. */
    @Modifying
    @Query("update Folder f set f.workspaceId = :to where f.workspaceId = :from")
    fun reassignWorkspace(@Param("from") from: UUID, @Param("to") to: UUID?): Int
}
