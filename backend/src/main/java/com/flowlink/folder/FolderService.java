package com.flowlink.folder;

import com.flowlink.common.error.NotFoundException;
import com.flowlink.common.tenant.TenantContext;
import com.flowlink.core.domain.Folder;
import com.flowlink.core.repository.FlowRepository;
import com.flowlink.core.repository.FolderRepository;
import com.flowlink.folder.FolderDtos.FolderSummary;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
public class FolderService {

    private final FolderRepository folderRepo;
    private final FlowRepository flowRepo;

    public FolderService(FolderRepository folderRepo, FlowRepository flowRepo) {
        this.folderRepo = folderRepo;
        this.flowRepo = flowRepo;
    }

    @Transactional(readOnly = true)
    public List<FolderSummary> list() {
        String tenant = tenant();
        return folderRepo.findByTenantIdOrderByNameAsc(tenant).stream()
                .map(f -> FolderSummary.from(f, flowRepo.countByTenantIdAndFolderIdAndArchivedFalse(tenant, f.getId())))
                .toList();
    }

    @Transactional
    public FolderSummary create(String name) {
        Folder f = folderRepo.saveAndFlush(Folder.create(tenant(), name));
        return FolderSummary.from(f, 0);
    }

    @Transactional
    public FolderSummary rename(UUID id, String name) {
        Folder f = load(id);
        f.setName(name);
        return FolderSummary.from(f, flowRepo.countByTenantIdAndFolderIdAndArchivedFalse(tenant(), id));
    }

    @Transactional
    public void delete(UUID id) {
        Folder f = load(id);
        flowRepo.clearFolder(id); // 폴더 내 워크플로는 미분류로
        folderRepo.delete(f);
    }

    private Folder load(UUID id) {
        return folderRepo.findByIdAndTenantId(id, tenant())
                .orElseThrow(() -> NotFoundException.of("Folder", id));
    }

    private static String tenant() {
        return TenantContext.getTenantId();
    }
}
