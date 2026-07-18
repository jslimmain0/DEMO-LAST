package com.flowlink.assistant

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.settings.SettingsService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service

/**
 * 어시스턴트 지식 — 팀 지침(인스트럭션) + **스킬(재사용 플로우 조각)**.
 * 스킬은 캔버스에 삽입하거나 AI 가 조합해 플로우를 만든다. [promptBlock] 이 시스템 프롬프트 블록으로 조립(길이 상한).
 * 설정(JSON)에 저장 — 마이그레이션 없음.
 */
@Service
class SkillService(
    private val settings: SettingsService,
    json: JsonService,
) {
    private val log = LoggerFactory.getLogger(SkillService::class.java)
    private val mapper: ObjectMapper = json.mapper()

    fun view(): SkillsView = SkillsView(instructions(), builtinSkills(), userSkills())

    fun instructions(): String = settings.get(KEY_INSTRUCTIONS) ?: ""

    fun builtinSkills(): List<Skill> = BuiltinSkills.RAW.map { r ->
        Skill(id = r.id, name = r.name, description = r.description, nodeTypes = r.nodeTypes,
            graph = parseGraph(r.graphJson), builtin = true)
    }

    fun userSkills(): List<Skill> {
        val raw = settings.get(KEY_SKILLS) ?: return emptyList()
        return try {
            mapper.readValue<List<Skill>>(raw).map { it.copy(builtin = false) }
        } catch (e: Exception) {
            // 파싱 실패는 조용히 버리지 않고 로그 — 손상 시 UI 는 빈 목록이 되지만 원인 기록.
            log.warn("사용자 스킬 JSON 파싱 실패(빈 목록으로 처리): {}", e.message); emptyList()
        }
    }

    /** 사용자 스킬 저장(editor). name 없는 스킬은 거절(조용한 유실 방지). */
    fun updateSkills(req: SkillsUpdateRequest) {
        if (req.user == null) return
        val cleaned = req.user.map { it.copy(builtin = false) }
        cleaned.firstOrNull { it.name.isBlank() }?.let { throw BadRequestException("이름 없는 스킬이 있습니다.") }
        settings.put(KEY_SKILLS, mapper.writeValueAsString(cleaned))
    }

    /** 팀 지침 저장(admin — 스토어드 프롬프트 인젝션 방지 위해 상위 권한). */
    fun updateInstructions(req: InstructionsUpdateRequest) {
        if (req.instructions != null) settings.put(KEY_INSTRUCTIONS, req.instructions)
    }

    /**
     * LLM 시스템 프롬프트에 얹을 지침 + 스킬 조각 목록(총 길이 상한 PROMPT_CAP).
     * 스킬은 이름·설명·조각 그래프를 제공해 어시스턴트가 재사용·조합하게 한다.
     */
    fun promptBlock(): String {
        val instr = instructions().trim()
        val skills = builtinSkills() + userSkills()
        if (instr.isEmpty() && skills.isEmpty()) return ""
        val sb = StringBuilder()
        if (instr.isNotEmpty()) {
            sb.append("\n\n## ORG INSTRUCTIONS (팀 지침 — 항상 우선 준수)\n").append(clip(instr, INSTR_CAP))
        }
        if (skills.isNotEmpty()) {
            sb.append("\n\n## SKILLS (재사용 가능한 플로우 조각 — 요청에 맞으면 이 조각을 그대로/변형해 조합)\n")
            for (s in skills) {
                if (sb.length > PROMPT_CAP) { sb.append("\n…(스킬 일부 생략)\n"); break }
                sb.append("\n### ").append(s.name)
                if (s.nodeTypes.isNotEmpty()) sb.append(" [노드: ").append(s.nodeTypes.joinToString(",")).append("]")
                if (s.description.isNotBlank()) sb.append(" — ").append(s.description)
                sb.append("\n")
                s.graph?.let { sb.append(clip(mapper.writeValueAsString(it), 2000)).append("\n") }
            }
        }
        return clip(sb.toString(), PROMPT_CAP)
    }

    private fun parseGraph(s: String): JsonNode? = try { mapper.readTree(s) } catch (e: Exception) { null }
    private fun clip(s: String, max: Int): String = if (s.length <= max) s else s.substring(0, max) + "…"

    companion object {
        const val KEY_INSTRUCTIONS = "assistant.instructions"
        const val KEY_SKILLS = "assistant.skills"
        private const val INSTR_CAP = 4000
        private const val PROMPT_CAP = 16000
    }
}
