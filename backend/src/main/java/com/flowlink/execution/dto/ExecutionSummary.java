package com.flowlink.execution.dto;

import com.flowlink.core.domain.Execution;
import com.flowlink.core.domain.ExecutionStatus;
import com.flowlink.core.domain.TriggerType;

import java.time.Instant;
import java.util.UUID;

public record ExecutionSummary(
        UUID id,
        UUID flowId,
        String flowName,
        ExecutionStatus status,
        TriggerType trigger,
        Instant startedAt,
        Instant finishedAt
) {
    public static ExecutionSummary from(Execution e, String flowName) {
        return new ExecutionSummary(e.getId(), e.getFlowId(), flowName, e.getStatus(), e.getTrigger(),
                e.getStartedAt(), e.getFinishedAt());
    }
}
