package com.flowlink.core.repository;

import com.flowlink.core.domain.Flow;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface FlowRepository extends JpaRepository<Flow, UUID> {

    List<Flow> findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(String tenantId);

    Optional<Flow> findByIdAndTenantId(UUID id, String tenantId);
}
