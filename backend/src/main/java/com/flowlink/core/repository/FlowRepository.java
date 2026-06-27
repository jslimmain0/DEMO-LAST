package com.flowlink.core.repository;

import com.flowlink.core.domain.Flow;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface FlowRepository extends JpaRepository<Flow, UUID> {

    List<Flow> findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(String tenantId);

    Optional<Flow> findByIdAndTenantId(UUID id, String tenantId);

    long countByTenantIdAndFolderIdAndArchivedFalse(String tenantId, UUID folderId);

    @Modifying
    @Query("update Flow f set f.folderId = null where f.folderId = :folderId")
    int clearFolder(@Param("folderId") UUID folderId);
}
