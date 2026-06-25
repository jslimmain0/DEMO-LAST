package com.flowlink.core.repository;

import com.flowlink.core.domain.Execution;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ExecutionRepository extends JpaRepository<Execution, UUID> {

    List<Execution> findByTenantIdOrderByStartedAtDesc(String tenantId, Pageable pageable);

    List<Execution> findByFlowIdOrderByStartedAtDesc(UUID flowId, Pageable pageable);

    Optional<Execution> findByIdAndTenantId(UUID id, String tenantId);
}
