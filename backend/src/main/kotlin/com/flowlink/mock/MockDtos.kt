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

    // 요청 DTO: @get:JvmName 금지 — jackson-module-kotlin 이 오인식해 역직렬화가 깨진다(spec JsonNode 바인딩 등).
    // 호출부(MockServerService)가 Kotlin 이라 프로퍼티(.name/.spec)로 접근하므로 accessor 별칭도 불필요.
    data class CreateMockServerRequest(
        @field:NotBlank val name: String,
        @field:NotBlank @field:Pattern(
            regexp = "[a-z0-9-]{3,40}",
            message = "slug 는 소문자·숫자·하이픈 3~40자"
        ) val slug: String
    )

    data class UpdateMockServerRequest(
        val name: String?,
        val enabled: Boolean?
    )

    data class UpdateMockSpecRequest(
        val spec: JsonNode?
    )
}
