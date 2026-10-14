package com.flowlink.protocol

import com.fasterxml.jackson.databind.JsonNode
import java.time.Instant
import java.util.UUID

object ProtocolDtos {
    data class Summary(val id: UUID, val name: String, val encoding: String, val messageCount: Int, val updatedAt: Instant?, val workspaceId: String = "public",
                       val schemaVersion: Int = 1, val transactionCount: Int = 0, val requiredCapabilities: Set<String> = emptySet())
    data class Detail(val id: UUID, val name: String, val spec: JsonNode, val createdAt: Instant, val updatedAt: Instant?, val workspaceId: String = "public",
                      val schemaVersion: Int = 1, val requiredCapabilities: Set<String> = emptySet(), val compiledSummary: Map<String, Any?> = emptyMap(), val warnings: List<String> = emptyList())
    data class SaveRequest(val name: String? = null, val spec: JsonNode? = null, val workspaceId: String? = null)
    /** 편집 중 spec 조립. direction은 기존 코덱 방향, frameDirection은 요청/응답 경계 선택. */
    data class PreviewRequest(val spec: JsonNode? = null, val key: String? = null, val values: Map<String, String>? = null, val direction: String? = null,
                              /** 코덱 파라미터의 `{{ 이름@secret }}`·`{{ 키@env }}` 를 풀 환경 */ val environment: String? = null,
                              val frameDirection: String? = null, val action: String? = null, val transactionKey: String? = null,
                              val phase: String? = null, val requestFields: Map<String, String> = emptyMap(), val responseFields: Map<String, String> = emptyMap(), val bytesB64: String? = null)
    data class PreviewError(val field: String?, val message: String, val code: String = "INVALID_SCHEMA", val path: String? = null, val repairHint: String? = null)
    data class CompilationReport(val valid: Boolean, val schemaVersion: Int = 1, val requiredCapabilities: Set<String> = emptySet(), val compiledSummary: Map<String, Any?> = emptyMap(),
                                 val warnings: List<String> = emptyList(), val errors: List<PreviewError> = emptyList())
    data class PreviewResult(val total: Int, val hex: String, val text: String, val fields: List<ProtocolCodec.FieldSlice>, val errors: List<PreviewError>, val warnings: List<String> = emptyList(),
                             val bytesB64: String? = null, val phase: String? = null, val transactionKey: String? = null, val declaredLength: Int? = null,
                             val wireLength: Int = total, val lengthAdjustment: Int = 0, val validations: List<Map<String, Any?>> = emptyList())
}

/** 프로토콜 저장 시 발행 — TCP 리스너가 핫스왑한다. */
data class ProtocolChangedEvent(val id: UUID, val spec: ProtocolSpec)
