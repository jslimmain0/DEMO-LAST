package com.flowlink.assistant

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/** Anthropic / OpenAI(GitHub Models) 요청·응답 포맷 변환 검증. */
class AssistantFormatTest {

    private val mapper = jacksonObjectMapper()
    private val msgs = listOf(ChatMessage("user", "안녕"), ChatMessage("assistant", "네"), ChatMessage("user", "플로우 만들어줘"))

    @Test
    fun `OpenAI 본문 — system 을 첫 메시지로, model·max_tokens`() {
        val b = AssistantService.openAiBody(mapper, "openai/gpt-4o", 4096, "SYS", msgs)
        assertThat(b.path("model").asText()).isEqualTo("openai/gpt-4o")
        assertThat(b.path("max_tokens").asInt()).isEqualTo(4096)
        val arr = b.path("messages")
        assertThat(arr.size()).isEqualTo(4) // system + 3
        assertThat(arr.path(0).path("role").asText()).isEqualTo("system")
        assertThat(arr.path(0).path("content").asText()).isEqualTo("SYS")
        assertThat(arr.path(1).path("role").asText()).isEqualTo("user")
        assertThat(arr.path(3).path("content").asText()).isEqualTo("플로우 만들어줘")
    }

    @Test
    fun `Anthropic 본문 — system 은 별도 필드`() {
        val b = AssistantService.anthropicBody(mapper, "claude-sonnet-5", 2048, "SYS", msgs)
        assertThat(b.path("system").asText()).isEqualTo("SYS")
        assertThat(b.path("messages").size()).isEqualTo(3) // system 은 메시지에 안 들어감
        assertThat(b.path("messages").path(0).path("role").asText()).isEqualTo("user")
    }

    @Test
    fun `OpenAI 응답 — choices0 message content 추출`() {
        val body = """{"choices":[{"message":{"role":"assistant","content":"{\"reply\":\"ok\"}"}}]}"""
        assertThat(AssistantService.extractOpenAiText(mapper, body)).isEqualTo("""{"reply":"ok"}""")
    }

    @Test
    fun `Anthropic 응답 — content text 블록 이어붙이기`() {
        val body = """{"content":[{"type":"text","text":"한글 "},{"type":"text","text":"응답"}]}"""
        assertThat(AssistantService.extractAnthropicText(mapper, body)).isEqualTo("한글 응답")
    }

    @Test
    fun `깨진 응답은 원문 반환(견고)`() {
        assertThat(AssistantService.extractOpenAiText(mapper, "not json")).isEqualTo("not json")
    }
}
