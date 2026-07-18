package com.flowlink.assistant

import com.fasterxml.jackson.databind.JsonNode
import java.time.Instant
import java.util.UUID

/** 세션 목록 항목 — 제목·최근 수정·대화 수. */
data class SessionSummary(val id: UUID, val title: String, val updatedAt: Instant, val messageCount: Int)

/** 세션 상세 — 대화 턴 배열(role/content/graph 라운드트립). */
data class SessionDetail(val id: UUID, val title: String, val messages: JsonNode, val updatedAt: Instant)

/** 세션 저장/수정 — messages 는 프론트 turns 배열 그대로. title 이 비면 첫 사용자 메시지로 자동. */
data class SaveSessionRequest(val title: String? = null, val messages: JsonNode? = null)
