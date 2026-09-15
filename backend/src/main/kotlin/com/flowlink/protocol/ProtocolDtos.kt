package com.flowlink.protocol

import com.fasterxml.jackson.databind.JsonNode
import java.time.Instant
import java.util.UUID

object ProtocolDtos {
    data class Summary(val id: UUID, val name: String, val encoding: String, val messageCount: Int, val updatedAt: Instant?)
    data class Detail(val id: UUID, val name: String, val spec: JsonNode, val createdAt: Instant, val updatedAt: Instant?)
    data class SaveRequest(val name: String? = null, val spec: JsonNode? = null)
    /** 편집 중 spec 으로 조립 미리보기 — 저장 없음. direction 은 send(기본)|recv(표 조회 방향). */
    data class PreviewRequest(val spec: JsonNode? = null, val key: String? = null, val values: Map<String, String>? = null, val direction: String? = null)
    data class PreviewError(val field: String?, val message: String)
    data class PreviewResult(val total: Int, val hex: String, val text: String, val fields: List<ProtocolCodec.FieldSlice>, val errors: List<PreviewError>, val warnings: List<String> = emptyList())
}

/** 프로토콜 저장 시 발행 — TCP 리스너가 핫스왑한다(Task 12). */
data class ProtocolChangedEvent(val id: UUID, val spec: ProtocolSpec)
