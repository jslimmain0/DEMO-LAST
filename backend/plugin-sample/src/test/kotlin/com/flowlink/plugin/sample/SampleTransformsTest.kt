package com.flowlink.plugin.sample

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class SampleTransformsTest {

    private val mask = MaskTransform()
    private val hmac = HmacSha256Transform()

    @Test
    fun `마스킹 - 카드번호 가운데 가림`() {
        val out = mask.apply(
            mapOf("input" to "1234567890123456"),
            mapOf("keepFront" to "6", "keepBack" to "4", "maskChar" to "*"),
        )
        assertEquals("123456******3456", out["result"])
    }

    @Test
    fun `마스킹 - 기본 설정(앞3 뒤4)`() {
        val out = mask.apply(mapOf("input" to "01012345678"), mapOf())
        assertEquals("010****5678", out["result"])
    }

    @Test
    fun `마스킹 - 남길 길이가 원문 이상이면 전체 마스킹`() {
        val out = mask.apply(mapOf("input" to "abc"), mapOf("keepFront" to "2", "keepBack" to "2"))
        assertEquals("***", out["result"])
    }

    @Test
    fun `HMAC-SHA256 - RFC 4231 테스트 벡터`() {
        // key="key", data="The quick brown fox jumps over the lazy dog" (널리 알려진 검증 벡터)
        val out = hmac.apply(
            mapOf("input" to "The quick brown fox jumps over the lazy dog"),
            mapOf("secret" to "key"),
        )
        assertEquals("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8", out["hex"])
        assertEquals("97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=", out["base64"])
    }

    @Test
    fun `SPI 선언 - 멀티 출력과 파라미터`() {
        assertEquals(listOf("hex", "base64"), hmac.outputs().map { it.key })
        assertEquals(listOf("keepFront", "keepBack", "maskChar"), mask.params().map { it.key })
    }
}
