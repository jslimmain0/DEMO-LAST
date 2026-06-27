package com.flowlink.core.repository;

import com.flowlink.core.domain.Folder;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface FolderRepository extends JpaRepository<Folder, UUID> {

    List<Folder> findByTenantIdOrderByNameAsc(String tenantId);

    Optional<Folder> findByIdAndTenantId(UUID id, String tenantId);
}
