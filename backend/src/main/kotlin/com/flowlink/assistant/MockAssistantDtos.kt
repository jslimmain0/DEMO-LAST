package com.flowlink.assistant

import com.fasterxml.jackson.databind.JsonNode

/**
 * Mock 어시스턴트 대화 요청 — 대화 이력 + 현재 mock spec(맥락) + 선택 mockId·model.
 * [spec] 은 프론트 MockServerSpec JSON 그대로. LLM 이 수정 대상으로 참고한다.
 */
data class MockAssistantChatRequest(
    val messages: List<ChatMessage> = emptyList(),
    val spec: JsonNode? = null,
    val mockId: String? = null,
    val model: String? = null,
)

/** Mock 어시스턴트 응답 — reply + 제안 spec(MockSpec JSON, 없으면 순수 대화). */
data class MockAssistantChatResponse(
    val reply: String,
    val spec: JsonNode?,
    val stub: Boolean,
    val model: String,
)
