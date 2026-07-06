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
    fun create(name: String, parentId: UUID?): FolderSummary {
        // 상위 폴더는 존재+테넌트 검증(다른 테넌트/삭제된 폴더 아래 생성 방지). null = 루트.
        val parent = parentId?.let { load(it) }
        val f = folderRepo.saveAndFlush(Folder.create(tenant(), name, parent?.id))
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
        // 하위 폴더는 한 단계 위로 승격, 안의 워크플로도 상위 폴더로(루트 폴더 삭제면 미분류)
        folderRepo.findByTenantIdOrderByNameAsc(tenant())
            .filter { it.parentId == id }
            .forEach { it.parentId = f.parentId }
        flowRepo.reassignFolder(id, f.parentId)
        folderRepo.delete(f)
    }

    private fun load(id: UUID): Folder =
        folderRepo.findByIdAndTenantId(id, tenant())
            .orElseThrow { NotFoundException.of("Folder", id) }

    private fun tenant(): String = TenantContext.getTenantId()
}
