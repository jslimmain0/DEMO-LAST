package com.flowlink.assistant

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * AI 어시스턴트 API — 자연어로 플로우를 만들고 고친다.
 * RBAC: OIDC 모드에선 assistant 경로 쓰기 규칙(editor/admin)에 걸린다. dev 모드는 permitAll.
 */
@RestController
@RequestMapping("/api/v1/assistant")
class AssistantController(private val service: AssistantService) {

    /** 가용 상태(패널이 stub/실제 표시). */
    @GetMapping("/config")
    fun config(): AssistantConfig = service.config()

    /** 대화 한 번 — 이력 + 현재 그래프를 받아 답변 + (선택)제안 그래프를 반환. */
    @PostMapping("/chat")
    fun chat(@RequestBody req: AssistantChatRequest): AssistantChatResponse = service.chat(req)
}
