package com.flowlink.assistant

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/** LLM 응답에서 {reply, graph} JSON 을 뽑는 균형 중괄호 스캐너 검증. */
class AssistantJsonTest {

    @Test
    fun `순수 JSON 객체 그대로`() {
        val s = """{"reply":"ok","graph":{"nodes":[]}}"""
        assertThat(AssistantService.extractJsonObject(s)).isEqualTo(s)
    }

    @Test
    fun `중첩 중괄호 균형 매칭`() {
        val s = """{"reply":"a","graph":{"nodes":[{"id":"n1","fields":{"body":[]}}],"edges":[]}}"""
        assertThat(AssistantService.extractJsonObject(s)).isEqualTo(s)
    }

    @Test
    fun `앞뒤 잡음 제거 — 첫 짝맞는 객체만`() {
        val s = "설명입니다:\n{\"reply\":\"x\",\"graph\":null}\n끝."
        assertThat(AssistantService.extractJsonObject(s)).isEqualTo("""{"reply":"x","graph":null}""")
    }

    @Test
    fun `문자열 리터럴 안의 중괄호는 무시`() {
        // reply 값에 } 가 들어가도 균형을 깨지 않음
        val s = """{"reply":"조건은 {{ a@n }} == '0000' 입니다","graph":null}"""
        assertThat(AssistantService.extractJsonObject(s)).isEqualTo(s)
    }

    @Test
    fun `이스케이프된 따옴표 처리`() {
        val s = """{"reply":"그는 \"안녕\" 이라 했다 {end}","graph":null}"""
        assertThat(AssistantService.extractJsonObject(s)).isEqualTo(s)
    }

    @Test
    fun `중괄호 없으면 null`() {
        assertThat(AssistantService.extractJsonObject("그냥 텍스트")).isNull()
    }
}
