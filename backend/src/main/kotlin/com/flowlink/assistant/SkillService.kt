package com.flowlink.assistant

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.flowlink.common.json.JsonService
import com.flowlink.settings.SettingsService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service

/**
 * 어시스턴트 지식 — 커스텀 인스트럭션 + 스킬(내장 + 사용자). 테넌트 설정(JSON)에 저장.
 * [promptBlock] 이 활성 지식을 시스템 프롬프트 블록으로 조립한다.
 */
@Service
class SkillService(
    private val settings: SettingsService,
    json: JsonService,
) {
    private val log = LoggerFactory.getLogger(SkillService::class.java)
    private val mapper: ObjectMapper = json.mapper()

    fun view(): SkillsView = SkillsView(instructions(), BuiltinSkills.ALL, userSkills())

    fun instructions(): String = settings.get(KEY_INSTRUCTIONS) ?: ""

    fun userSkills(): List<Skill> {
        val raw = settings.get(KEY_SKILLS) ?: return emptyList()
        return try {
            mapper.readValue<List<Skill>>(raw).map { it.copy(builtin = false) }
        } catch (e: Exception) {
            log.warn("사용자 스킬 JSON 파싱 실패(무시): {}", e.message); emptyList()
        }
    }

    fun update(req: SkillsUpdateRequest) {
        // instructions: null=변경 없음, ""=삭제(설정 규약), 그 외 저장
        if (req.instructions != null) settings.put(KEY_INSTRUCTIONS, req.instructions)
        if (req.user != null) {
            val sanitized = req.user.map { it.copy(builtin = false) }
            settings.put(KEY_SKILLS, mapper.writeValueAsString(sanitized))
        }
    }

    /** LLM 시스템 프롬프트에 얹을 지침 + 활성 스킬 블록(없으면 빈 문자열). */
    fun promptBlock(): String = buildPromptBlock(instructions(), BuiltinSkills.ALL + userSkills())

    companion object {
        const val KEY_INSTRUCTIONS = "assistant.instructions"
        const val KEY_SKILLS = "assistant.skills"

        /** 순수 조립(테스트용) — 지침 + 활성·비어있지 않은 스킬을 프롬프트 블록으로. */
        fun buildPromptBlock(instructions: String, skills: List<Skill>): String {
            val instr = instructions.trim()
            val active = skills.filter { it.enabled && it.instruction.isNotBlank() }
            if (instr.isEmpty() && active.isEmpty()) return ""
            return buildString {
                if (instr.isNotEmpty()) {
                    append("\n\n## ORG INSTRUCTIONS (팀 지침 — 항상 우선 준수)\n")
                    append(instr)
                }
                if (active.isNotEmpty()) {
                    append("\n\n## AVAILABLE SKILLS (관련될 때 적용)\n")
                    for (s in active) {
                        append("\n### ").append(s.name)
                        if (s.nodeTypes.isNotEmpty()) append(" [노드: ").append(s.nodeTypes.joinToString(",")).append("]")
                        append("\n").append(s.instruction.trim()).append("\n")
                    }
                }
            }
        }
    }
}
