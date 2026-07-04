package com.flowlink.mock;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

import java.time.Instant;
import java.util.UUID;

/** Mock 서버 관리 API DTO 모음(FolderDtos 패턴). */
public final class MockDtos {

    private MockDtos() {
    }

    public record MockServerSummary(
            UUID id, String name, String slug, String kind, boolean enabled, Instant updatedAt) {
    }

    public record MockServerDetail(
            UUID id, String name, String slug, String kind, boolean enabled,
            JsonNode spec, Instant createdAt, Instant updatedAt) {
    }

    public record CreateMockServerRequest(
            @NotBlank String name,
            @NotBlank @Pattern(regexp = "[a-z0-9-]{3,40}", message = "slug 는 소문자·숫자·하이픈 3~40자") String slug
    ) {
    }

    public record UpdateMockServerRequest(String name, Boolean enabled) {
    }

    public record UpdateMockSpecRequest(JsonNode spec) {
    }
}
