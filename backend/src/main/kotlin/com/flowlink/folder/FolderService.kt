package com.flowlink.folder

import com.flowlink.common.error.BadRequestException
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
    private val log = org.slf4j.LoggerFactory.getLogger(FolderService::class.java)


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
        log.info("폴더 생성: id={} name='{}' parent={}", f.id, name, parent?.id ?: "(루트)")
        return FolderSummary.from(f, 0L)
    }

    @Transactional
    fun rename(id: UUID, name: String): FolderSummary {
        val f = load(id)
        log.info("폴더 이름 변경: id={} '{}' → '{}'", id, f.name, name)
        f.name = name
        return FolderSummary.from(f, flowRepo.countByTenantIdAndFolderIdAndArchivedFalse(tenant(), id))
    }

    /**
     * 폴더 재배치(드래그 이동) — parentId=null 이면 루트로.
     * 사이클 방지: 자기 자신·자기 하위 폴더 아래로는 이동 불가.
     */
    @Transactional
    fun move(id: UUID, parentId: UUID?): FolderSummary {
        val f = load(id)
        if (parentId == null) {
            f.parentId = null
        } else {
            if (parentId == id) {
                throw BadRequestException("폴더를 자기 자신 아래로 옮길 수 없습니다.")
            }
            val byId = folderRepo.findByTenantIdOrderByNameAsc(tenant()).associateBy { it.id }
            val parent = byId[parentId] ?: throw NotFoundException.of("Folder", parentId)
            var cur: Folder? = parent
            var guard = 0
            while (cur != null && guard++ < 100) {
                if (cur.id == id) {
                    throw BadRequestException("폴더를 자기 하위 폴더 아래로 옮길 수 없습니다.")
                }
                cur = cur.parentId?.let { byId[it] }
            }
            f.parentId = parent.id
        }
        log.info("폴더 재배치: id={} → parent={}", id, parentId ?: "(루트)")
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
        log.info("폴더 삭제: id={} name='{}' — 하위 폴더·워크플로는 상위({})로 승격", id, f.name, f.parentId ?: "(루트)")
    }

    private fun load(id: UUID): Folder =
        folderRepo.findByIdAndTenantId(id, tenant())
            .orElseThrow { NotFoundException.of("Folder", id) }

    // 폴더는 워크플로우 컨테이너 계층 — flow 와 함께 전역 공유(로그인 테넌트 무관, 공유 테넌트로).
    private fun tenant(): String = TenantContext.SHARED_FLOW_TENANT
}
