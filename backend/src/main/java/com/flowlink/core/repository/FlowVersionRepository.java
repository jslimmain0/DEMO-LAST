package com.flowlink.core.repository;

import com.flowlink.core.domain.FlowVersion;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface FlowVersionRepository extends JpaRepository<FlowVersion, UUID> {

    List<FlowVersion> findByFlowIdOrderByVersionNoDesc(UUID flowId);

    Optional<FlowVersion> findByFlowIdAndVersionNo(UUID flowId, int versionNo);
}
