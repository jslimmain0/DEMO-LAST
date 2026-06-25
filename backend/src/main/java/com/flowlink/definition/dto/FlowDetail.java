package com.flowlink.definition.dto;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.UUID;

/** 편집기용 상세 — 현재 버전의 그래프를 포함한다. */
public record FlowDetail(
        UUID id,
        String name,
        String description,
        int currentVersion,
        Instant createdAt,
        Instant updatedAt,
        JsonNode graph
) {
}
