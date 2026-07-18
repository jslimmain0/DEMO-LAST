package com.flowlink.assistant

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * 어시스턴트 스킬 — 재사용 지식 조각. LLM 시스템 프롬프트에 주입돼 조직 맞춤 플로우를 생성하게 한다.
 * [nodeTypes] 로 특정 노드 타입에 관련됨을 표시(노드별 스킬). [builtin] 은 코드 내장(수정 불가).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class Skill(
    val name: String = "",
    val description: String = "",
    val instruction: String = "",
    val nodeTypes: List<String> = emptyList(),
    val enabled: Boolean = true,
    val builtin: Boolean = false,
)

/** 스킬/지침 조회 — 커스텀 인스트럭션 + 내장 스킬(읽기전용) + 사용자 스킬. */
data class SkillsView(
    val instructions: String,
    val builtin: List<Skill>,
    val user: List<Skill>,
)

/** 스킬/지침 저장 — 둘 중 준 것만 반영(instructions 빈 문자열=삭제, user 는 전체 교체). */
data class SkillsUpdateRequest(
    val instructions: String? = null,
    val user: List<Skill>? = null,
)
