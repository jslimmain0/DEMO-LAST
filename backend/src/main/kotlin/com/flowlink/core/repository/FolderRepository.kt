package com.flowlink.core.repository

import com.flowlink.core.domain.Folder
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface FolderRepository : JpaRepository<Folder, UUID> {

    fun findByTenantIdOrderByNameAsc(tenantId: String): List<Folder>

    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<Folder>
}
