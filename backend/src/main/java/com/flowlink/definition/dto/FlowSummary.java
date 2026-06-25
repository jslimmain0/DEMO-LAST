package com.flowlink.definition.dto;

import com.flowlink.core.domain.Flow;

import java.time.Instant;
import java.util.UUID;

/** 대시보드 목록용 요약. */
public record FlowSummary(
        UUID id,
        String name,
        String description,
        int currentVersion,
        Instant updatedAt
) {
    public static FlowSummary from(Flow f) {
        return new FlowSummary(f.getId(), f.getName(), f.getDescription(),
                f.getCurrentVersion(), f.getUpdatedAt());
    }
}
