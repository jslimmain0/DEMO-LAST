package com.flowlink.assistant

import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/**
 * AI 어시스턴트 API — 자연어로 플로우를 만들고 고친다.
 * RBAC: OIDC 모드에선 assistant 경로 쓰기 규칙(editor/admin)에 걸린다. dev 모드는 permitAll.
 */
@RestController
@RequestMapping("/api/v1/assistant")
class AssistantController(
    private val service: AssistantService,
    private val skills: SkillService,
    private val sessions: AssistantSessionService,
    private val mockAssistant: MockAssistantService,
) {

    /** 가용 상태(패널이 stub/실제 표시). */
    @GetMapping("/config")
    fun config(): AssistantConfig = service.config()

    /** 대화 한 번 — 이력 + 현재 그래프를 받아 답변 + (선택)제안 그래프를 반환. */
    @PostMapping("/chat")
    fun chat(@RequestBody req: AssistantChatRequest): AssistantChatResponse = service.chat(req)

    /** Mock 어시스턴트 — 이력 + 현재 mock spec 을 받아 답변 + (선택)제안 spec 을 반환. */
    @PostMapping("/mock")
    fun mockChat(@RequestBody req: MockAssistantChatRequest): MockAssistantChatResponse = mockAssistant.chat(req)

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

    // --- 대화 세션(사용자별 저장·목록·이어하기) ---

    /** 내 세션 목록(최근순). */
    @GetMapping("/sessions")
    fun listSessions(): List<SessionSummary> = sessions.list()

    /** 세션 상세(대화 턴 복원). */
    @GetMapping("/sessions/{id}")
    fun getSession(@PathVariable id: UUID): SessionDetail = sessions.get(id)

    /** 새 세션 생성(첫 대화 저장). */
    @PostMapping("/sessions")
    fun createSession(@RequestBody req: SaveSessionRequest): SessionDetail = sessions.create(req)

    /** 세션 갱신(대화 이어붙이기 / 이름 변경). */
    @PutMapping("/sessions/{id}")
    fun updateSession(@PathVariable id: UUID, @RequestBody req: SaveSessionRequest): SessionDetail = sessions.update(id, req)

    /** 세션 삭제. */
    @DeleteMapping("/sessions/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun deleteSession(@PathVariable id: UUID) = sessions.delete(id)
}
