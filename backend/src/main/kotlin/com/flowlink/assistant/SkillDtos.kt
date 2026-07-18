package com.flowlink.assistant

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * 스킬 = **재사용 프롬프트**(awesome-copilot 스타일). 이름·설명·프롬프트 본문으로,
 * 어시스턴트에 클릭 한 번으로 적용(전송)한다. 자동 주입이 아니라 사용자가 불러 쓴다.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class Skill(
    val id: String = "",
    val name: String = "",
    val description: String = "",
    val prompt: String = "",
)

/** 프롬프트 라이브러리 + 팀 지침(인스트럭션 — 자동 주입). */
data class SkillsView(
    val instructions: String,
    val user: List<Skill>,
)

/** 사용자 프롬프트 저장(전체 교체, editor). */
data class SkillsUpdateRequest(
    val user: List<Skill>? = null,
)

/** 팀 지침 저장(admin). */
data class InstructionsUpdateRequest(
    val instructions: String? = null,
)
