package com.flowlink.folder

import com.flowlink.common.error.NotFoundException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Folder
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FolderRepository
import com.flowlink.folder.FolderDtos.FolderSummary
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

@Service
class FolderService(
    private val folderRepo: FolderRepository,
    private val flowRepo: FlowRepository
) {

    @Transactional(readOnly = true)
    fun list(): List<FolderSummary> {
        val tenant = tenant()
        return folderRepo.findByTenantIdOrderByNameAsc(tenant)
            .map { FolderSummary.from(it, flowRepo.countByTenantIdAndFolderIdAndArchivedFalse(tenant, it.id)) }
    }

    @Transactional
    fun create(name: String): FolderSummary {
        val f = folderRepo.saveAndFlush(Folder.create(tenant(), name))
        return FolderSummary.from(f, 0L)
    }

    @Transactional
    fun rename(id: UUID, name: String): FolderSummary {
        val f = load(id)
        f.name = name
        return FolderSummary.from(f, flowRepo.countByTenantIdAndFolderIdAndArchivedFalse(tenant(), id))
    }

    @Transactional
    fun delete(id: UUID) {
        val f = load(id)
        flowRepo.clearFolder(id) // 폴더 내 워크플로는 미분류로
        folderRepo.delete(f)
    }

    private fun load(id: UUID): Folder =
        folderRepo.findByIdAndTenantId(id, tenant())
            .orElseThrow { NotFoundException.of("Folder", id) }

    private fun tenant(): String = TenantContext.getTenantId()
}
