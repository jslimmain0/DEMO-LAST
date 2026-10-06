package com.flowlink.execution.engine

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * 시크릿 마스킹 유틸 — 캡처 텍스트에서 시크릿 원문과 인코딩 변형(URL 인코딩·JSON 이스케이프)을
 * `••••••` 로 치환한다. 전체 실행(recorder)과 단일 노드 실행 응답이 같은 규칙을 공유한다.
 */
class SecretMaskerTest {

    @Test
    fun `원문 값을 마스킹한다`() {
        val masks = SecretMasker.variants(listOf("demo-key-777"))
        assertThat(SecretMasker.mask("Bearer demo-key-777 끝", masks)).isEqualTo("Bearer •••••• 끝")
    }

    @Test
    fun `URL 인코딩 변형도 마스킹한다`() {
        val masks = SecretMasker.variants(listOf("k y+/="))
        val text = "q=" + java.net.URLEncoder.encode("k y+/=", Charsets.UTF_8)
        assertThat(SecretMasker.mask(text, masks)).isEqualTo("q=••••••")
    }

    @Test
    fun `JSON 이스케이프 변형도 마스킹한다`() {
        val masks = SecretMasker.variants(listOf("say \"hi\"\nnow"))
        val json = """{"token":"say \"hi\"\nnow"}"""
        assertThat(SecretMasker.mask(json, masks)).isEqualTo("""{"token":"••••••"}""")
    }

    @Test
    fun `긴 값을 먼저 치환해 부분 문자열 시크릿이 잔재를 남기지 않는다`() {
        val masks = SecretMasker.variants(listOf("abc", "abc-extended"))
        assertThat(SecretMasker.mask("token=abc-extended;short=abc", masks))
            .isEqualTo("token=••••••;short=••••••")
    }

    @Test
    fun `빈 시크릿과 null 텍스트는 안전하게 통과한다`() {
        assertThat(SecretMasker.variants(listOf("", "  "))).isEmpty()
        assertThat(SecretMasker.mask(null, listOf("x"))).isNull()
        assertThat(SecretMasker.mask("그대로", emptyList())).isEqualTo("그대로")
    }
}
