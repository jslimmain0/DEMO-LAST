package com.flowlink.assistant

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/** 지침+스킬 → 프롬프트 블록 조립 검증(순수). */
class SkillPromptTest {

    @Test
    fun `지침·스킬 없으면 빈 문자열`() {
        assertThat(SkillService.buildPromptBlock("", emptyList())).isEmpty()
    }

    @Test
    fun `지침만 있으면 ORG INSTRUCTIONS 블록`() {
        val out = SkillService.buildPromptBlock("항상 서버 모드", emptyList())
        assertThat(out).contains("ORG INSTRUCTIONS").contains("항상 서버 모드")
        assertThat(out).doesNotContain("AVAILABLE SKILLS")
    }

    @Test
    fun `활성 스킬만 포함 — 비활성·빈 지시는 제외`() {
        val skills = listOf(
            Skill(name = "A", instruction = "지시 A", nodeTypes = listOf("http"), enabled = true),
            Skill(name = "B", instruction = "지시 B", enabled = false),
            Skill(name = "C", instruction = "", enabled = true),
        )
        val out = SkillService.buildPromptBlock("", skills)
        assertThat(out).contains("### A").contains("지시 A").contains("[노드: http]")
        assertThat(out).doesNotContain("지시 B")   // 비활성
        assertThat(out).doesNotContain("### C")    // 빈 지시
    }

    @Test
    fun `지침 + 스킬 함께`() {
        val out = SkillService.buildPromptBlock("팀 규칙", listOf(Skill(name = "OAuth", instruction = "토큰 받기", enabled = true)))
        assertThat(out).contains("ORG INSTRUCTIONS").contains("팀 규칙")
        assertThat(out).contains("AVAILABLE SKILLS").contains("### OAuth").contains("토큰 받기")
    }
}
