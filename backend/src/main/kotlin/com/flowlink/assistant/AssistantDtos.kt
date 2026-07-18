package com.flowlink.assistant

import com.fasterxml.jackson.databind.JsonNode

/** 대화 한 턴. role = "user" | "assistant". */
data class ChatMessage(val role: String, val content: String)

/**
 * 채팅 요청 — 대화 이력 + 현재 캔버스 그래프(맥락).
 * [graph] 는 프론트 getGraph() 결과(FlowGraph JSON) 그대로 — LLM 이 수정 대상으로 참고한다.
 */
data class AssistantChatRequest(
    val messages: List<ChatMessage> = emptyList(),
    val graph: JsonNode? = null,
)

/**
 * 채팅 응답.
 * [reply] 자연어 답변, [graph] 제안 그래프(FlowGraph JSON, 없으면 순수 대화),
 * [stub] LLM 키 없이 샘플로 생성했는지, [model] 사용 모델(또는 "stub").
 */
data class AssistantChatResponse(
    val reply: String,
    val graph: JsonNode?,
    val stub: Boolean,
    val model: String,
)

/** 어시스턴트 가용 상태 — 프론트 패널이 stub/실제 여부·모델을 표시. */
data class AssistantConfig(
    val available: Boolean, // 항상 true(stub 폴백) — 패널을 열 수 있는지
    val usingRealLlm: Boolean, // 실제 LLM 키가 설정됐는지
    val model: String,
)
