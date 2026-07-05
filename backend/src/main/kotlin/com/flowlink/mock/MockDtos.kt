package com.flowlink.mock

import com.fasterxml.jackson.databind.JsonNode
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import java.time.Instant
import java.util.UUID

/** Mock 서버 관리 API DTO 모음(FolderDtos 패턴). */
object MockDtos {

    data class MockServerSummary(
        val id: UUID,
        val name: String,
        val slug: String,
        val kind: String,
        val enabled: Boolean,
        val updatedAt: Instant
    )

    data class MockServerDetail(
        val id: UUID,
        val name: String,
        val slug: String,
        val kind: String,
        val enabled: Boolean,
        val spec: JsonNode,
        val createdAt: Instant,
        val updatedAt: Instant
    )

    data class CreateMockServerRequest(
        @get:JvmName("name")
        @field:NotBlank val name: String,
        @get:JvmName("slug")
        @field:NotBlank @field:Pattern(
            regexp = "[a-z0-9-]{3,40}",
            message = "slug 는 소문자·숫자·하이픈 3~40자"
        ) val slug: String
    )

    data class UpdateMockServerRequest(
        @get:JvmName("name")
        val name: String?,
        @get:JvmName("enabled")
        val enabled: Boolean?
    )

    data class UpdateMockSpecRequest(
        @get:JvmName("spec")
        val spec: JsonNode?
    )
}
