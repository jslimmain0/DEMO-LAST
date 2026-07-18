package com.flowlink.assistant

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * AI 어시스턴트 API — 자연어로 플로우를 만들고 고친다.
 * RBAC: OIDC 모드에선 assistant 경로 쓰기 규칙(editor/admin)에 걸린다. dev 모드는 permitAll.
 */
@RestController
@RequestMapping("/api/v1/assistant")
class AssistantController(
    private val service: AssistantService,
    private val skills: SkillService,
) {

    /** 가용 상태(패널이 stub/실제 표시). */
    @GetMapping("/config")
    fun config(): AssistantConfig = service.config()

    /** 대화 한 번 — 이력 + 현재 그래프를 받아 답변 + (선택)제안 그래프를 반환. */
    @PostMapping("/chat")
    fun chat(@RequestBody req: AssistantChatRequest): AssistantChatResponse = service.chat(req)

    /** 지침 + 스킬(내장/사용자 플로우 조각) 조회. */
    @GetMapping("/skills")
    fun skills(): SkillsView = skills.view()

    /** 사용자 스킬(플로우 조각) 저장 — editor. */
    @PutMapping("/skills")
    fun updateSkills(@RequestBody req: SkillsUpdateRequest): SkillsView {
        skills.updateSkills(req)
        return skills.view()
    }

    /** 팀 지침 저장 — admin(스토어드 프롬프트 인젝션 방지 위해 상위 권한). */
    @PutMapping("/instructions")
    fun updateInstructions(@RequestBody req: InstructionsUpdateRequest): SkillsView {
        skills.updateInstructions(req)
        return skills.view()
    }
}
