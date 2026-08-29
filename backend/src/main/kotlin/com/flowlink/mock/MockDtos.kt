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
        val updatedAt: Instant,
        val workspaceId: UUID? = null
    )

    data class MockServerDetail(
        val id: UUID,
        val name: String,
        val slug: String,
        val kind: String,
        val enabled: Boolean,
        val spec: JsonNode,
        val createdAt: Instant,
        val updatedAt: Instant,
        val workspaceId: UUID? = null
    )

    // 요청 DTO: @get:JvmName 금지 — jackson-module-kotlin 이 오인식해 역직렬화가 깨진다(spec JsonNode 바인딩 등).
    // 호출부(MockServerService)가 Kotlin 이라 프로퍼티(.name/.spec)로 접근하므로 accessor 별칭도 불필요.
    data class CreateMockServerRequest(
        @field:NotBlank val name: String,
        @field:NotBlank @field:Pattern(
            regexp = "[a-z0-9-]{3,40}",
            message = "slug 는 소문자·숫자·하이픈 3~40자"
        ) val slug: String,
        // 유형 — "HTTP"(경로·응답) | "TCP"(소켓 전문). 미지정/그 외는 HTTP. (@get:JvmName 금지 규칙 준수)
        val type: String? = null,
        /** 소속 워크스페이스 — 'public'/null=공용, UUID=팀/개인. */
        val workspaceId: String? = null
    )

    data class UpdateMockServerRequest(
        val name: String?,
        val enabled: Boolean?
    )

    data class UpdateMockSpecRequest(
        val spec: JsonNode?
    )

    /** 요청 기록 1건 — mock 에 온 실제 요청(디버깅·검증용). */
    data class MockRequestLog(
        val at: java.time.Instant,
        val method: String,
        val path: String,
        val query: Map<String, String>,
        val headers: Map<String, String>,
        val bodyText: String,
        val matchedRuleId: String?,
        val status: Int,
        val delayMs: Int,
        val callbackFired: Boolean,
    )

    /** 런타임 상태 스냅샷 — 상태 있는 목 디버깅용. */
    data class MockStateView(
        val state: Map<String, String>,
        val seq: Long,
        val hits: Map<String, Int>,
        val requestCount: Int,
    )
}
