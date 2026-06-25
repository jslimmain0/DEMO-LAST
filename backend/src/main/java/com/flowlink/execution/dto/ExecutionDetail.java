package com.flowlink.execution.dto;

import com.flowlink.core.domain.ExecutionStatus;
import com.flowlink.core.domain.TriggerType;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record ExecutionDetail(
        UUID id,
        UUID flowId,
        UUID flowVersionId,
        ExecutionStatus status,
        TriggerType trigger,
        String triggeredBy,
        Instant startedAt,
        Instant finishedAt,
        String error,
        List<NodeExecutionView> nodes
) {
}
