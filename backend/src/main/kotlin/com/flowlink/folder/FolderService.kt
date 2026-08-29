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
    private val flowRepo: FlowRepository,
    private val workspace: com.flowlink.workspace.WorkspaceService,
) {

    @Transactional(readOnly = true)
    fun list(workspaceIdRaw: String? = null): List<FolderSummary> {
        val tenant = tenant()
        val wsId = workspace.resolveId(workspaceIdRaw)
        workspace.requireRead(workspace.currentUsername(), wsId)
        // 폴더별 워크플로 수를 group by 1 쿼리로 — 폴더당 count 재조회 N+1 제거
        val counts = flowRepo.countGroupByFolder(tenant).associate { it[0] as UUID to it[1] as Long }
        return folderRepo.findByTenantIdOrderByNameAsc(tenant)
            .filter { it.workspaceId == wsId }
            .map { FolderSummary.from(it, counts[it.id] ?: 0L) }
    }

    @Transactional
    fun create(name: String, parentId: UUID?, workspaceIdRaw: String? = null): FolderSummary {
        val wsId = workspace.resolveId(workspaceIdRaw)
        workspace.requireWrite(workspace.currentUsername(), wsId)
        // 상위 폴더는 존재+테넌트 검증(다른 테넌트/삭제된 폴더 아래 생성 방지). null = 루트.
        val parent = parentId?.let { load(it) }
        // 요청 워크스페이스와 상위 폴더의 워크스페이스가 다르면 거부 — 조용한 오배치(팀에 만든 줄 알았는데
        // 공용에 생성 등) 방지. 승계가 아니라 명시적 불일치 거부.
        if (parent != null && parent.workspaceId != wsId) {
            throw BadRequestException("상위 폴더가 다른 워크스페이스에 있습니다.")
        }
        val entity = Folder.create(tenant(), name, parent?.id)
        entity.workspaceId = wsId
        val f = folderRepo.saveAndFlush(entity)
        return FolderSummary.from(f, 0L)
    }

    @Transactional
    fun rename(id: UUID, name: String): FolderSummary {
        val f = load(id)
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
            if (parent.workspaceId != f.workspaceId) {
                throw BadRequestException("다른 워크스페이스의 폴더 아래로는 옮길 수 없습니다.")
            }
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

    private fun load(id: UUID): Folder {
        val f = folderRepo.findByIdAndTenantId(id, tenant())
            .orElseThrow { NotFoundException.of("Folder", id) }
        workspace.requireWrite(workspace.currentUsername(), f.workspaceId) // 폴더 조작은 전부 쓰기 성격
        return f
    }

    // 폴더는 워크플로우 컨테이너 계층 — flow 와 함께 전역 공유(로그인 테넌트 무관, 공유 테넌트로).
    private fun tenant(): String = TenantContext.SHARED_FLOW_TENANT
}
