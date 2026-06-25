package com.flowlink.definition.dto;

import com.flowlink.core.domain.FlowVersion;

import java.time.Instant;
import java.util.UUID;

public record FlowVersionSummary(
        UUID id,
        int versionNo,
        String name,
        String note,
        String createdBy,
        Instant createdAt
) {
    public static FlowVersionSummary from(FlowVersion v) {
        return new FlowVersionSummary(v.getId(), v.getVersionNo(), v.getName(),
                v.getNote(), v.getCreatedBy(), v.getCreatedAt());
    }
}
