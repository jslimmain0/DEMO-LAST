package com.flowlink.assistant

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.databind.JsonNode

/**
 * 스킬 = **재사용 가능한 플로우 조각**. [graph] 는 {nodes, edges} 서브그래프로, 캔버스에 삽입해 플로우를 조립한다.
 * AI 어시스턴트도 이 조각들을 알고 조합해 플로우를 만든다. [builtin] 은 코드 내장(수정 불가).
 * [nodeTypes] 는 조각에 든 노드 타입(프론트가 저장 시 계산 — "노드별" 표시/필터용).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class Skill(
    val id: String = "",
    val name: String = "",
    val description: String = "",
    val nodeTypes: List<String> = emptyList(),
    val graph: JsonNode? = null,
    val builtin: Boolean = false,
)

/** 스킬 라이브러리 + 팀 지침(인스트럭션). */
data class SkillsView(
    val instructions: String,
    val builtin: List<Skill>,
    val user: List<Skill>,
)

/** 사용자 스킬 저장(전체 교체). */
data class SkillsUpdateRequest(
    val user: List<Skill>? = null,
)

/** 팀 지침 저장(빈 문자열=삭제). admin 전용. */
data class InstructionsUpdateRequest(
    val instructions: String? = null,
)
