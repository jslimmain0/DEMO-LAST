package com.flowlink.core.repository;

import com.flowlink.core.domain.NodeExecution;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface NodeExecutionRepository extends JpaRepository<NodeExecution, UUID> {

    List<NodeExecution> findByExecutionIdOrderBySeqAsc(UUID executionId);
}
