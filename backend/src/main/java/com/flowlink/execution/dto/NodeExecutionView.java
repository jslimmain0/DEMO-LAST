package com.flowlink.execution.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.flowlink.core.domain.NodeExecutionStatus;

import java.util.UUID;

public record NodeExecutionView(
        UUID id,
        String nodeId,
        String nodeName,
        String nodeType,
        int seq,
        NodeExecutionStatus status,
        Integer httpStatus,
        Long durationMs,
        boolean ok,
        String requestText,
        String responseText,
        JsonNode output
) {
}
