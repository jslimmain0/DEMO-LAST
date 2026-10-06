package com.flowlink.assistant

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.settings.SettingsService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service

/**
 * 어시스턴트 지식 — 팀 지침(인스트럭션, 자동 주입) + **프롬프트 스킬**(awesome-copilot 스타일, 사용자가 불러 씀).
 * 프롬프트는 클릭 시 채팅으로 전송되는 것이라 시스템 프롬프트에 자동 주입하지 않는다(지침만 주입).
 * 설정(JSON)에 저장 — 마이그레이션 없음.
 */
@Service
class SkillService(
    private val settings: SettingsService,
    json: JsonService,
) {
    private val log = LoggerFactory.getLogger(SkillService::class.java)
    private val mapper: ObjectMapper = json.mapper()

    fun view(): SkillsView = SkillsView(instructions(), userSkills())

    fun instructions(): String = settings.get(KEY_INSTRUCTIONS) ?: ""

    fun userSkills(): List<Skill> {
        val raw = settings.get(KEY_SKILLS) ?: return emptyList()
        return try {
            mapper.readValue<List<Skill>>(raw)
        } catch (e: Exception) {
            log.warn("사용자 스킬 JSON 파싱 실패(빈 목록으로 처리): {}", e.message); emptyList()
        }
    }

    /** 사용자 프롬프트 저장(editor). name 없는 항목은 거절. */
    fun updateSkills(req: SkillsUpdateRequest) {
        if (req.user == null) return
        req.user.firstOrNull { it.name.isBlank() }?.let { throw BadRequestException("이름 없는 프롬프트가 있습니다.") }
        settings.put(KEY_SKILLS, mapper.writeValueAsString(req.user))
    }

    /** 팀 지침 저장(admin — 스토어드 프롬프트 인젝션 방지 위해 상위 권한). */
    fun updateInstructions(req: InstructionsUpdateRequest) {
        if (req.instructions != null) settings.put(KEY_INSTRUCTIONS, req.instructions)
    }

    /** LLM 시스템 프롬프트에 얹을 **팀 지침** 블록(프롬프트 스킬은 자동 주입 안 함 — 사용자가 불러 씀). */
    fun promptBlock(): String {
        val instr = instructions().trim()
        if (instr.isEmpty()) return ""
        return "\n\n## ORG INSTRUCTIONS (팀 지침 — 항상 우선 준수)\n" + clip(instr, INSTR_CAP)
    }

    private fun clip(s: String, max: Int): String = if (s.length <= max) s else s.substring(0, max) + "…"

    companion object {
        const val KEY_INSTRUCTIONS = "assistant.instructions"
        const val KEY_SKILLS = "assistant.skills"
        private const val INSTR_CAP = 4000
    }
}
