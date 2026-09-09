package com.flowlink.common.text

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.time.Instant

/** 현재 일시 토큰 — 고정 시각으로 KST 기본·패턴·타임존·판별·오류를 검증. */
class NowTokensTest {

    private val at = Instant.parse("2026-09-09T05:04:05.123Z") // KST 2026-09-09 14:04:05

    @Test
    fun `기본은_KST`() {
        assertThat(NowTokens.resolve("today", null, at)).isEqualTo("20260909")
        assertThat(NowTokens.resolve("time", null, at)).isEqualTo("140405")
        assertThat(NowTokens.resolve("now:yyyy-MM-dd HH:mm:ss", null, at)).isEqualTo("2026-09-09 14:04:05")
        assertThat(NowTokens.resolve("now:yyyyMMddHHmmssSSS", null, at)).isEqualTo("20260909140405123")
        assertThat(NowTokens.resolve("now", null, at)).isEqualTo("2026-09-09T05:04:05.123Z") // 기존 규약 그대로
    }

    @Test
    fun `타임존`() {
        assertThat(NowTokens.resolve("now:HHmm", "UTC", at)).isEqualTo("0504")
        val late = Instant.parse("2026-09-09T20:00:00Z")
        assertThat(NowTokens.resolve("today", "UTC", late)).isEqualTo("20260909")
        assertThat(NowTokens.resolve("today", null, late)).isEqualTo("20260910") // KST 는 다음날
        assertThat(NowTokens.resolve("now", "Asia/Seoul", at)).isEqualTo("2026-09-09T14:04:05.123+09:00")
        assertThat(NowTokens.resolve("now", "nope", at)).isNull()
    }

    @Test
    fun `판별과_오류`() {
        assertThat(NowTokens.isTimeKey("now:yyyyMMdd")).isTrue()
        assertThat(NowTokens.isTimeKey("today")).isTrue()
        assertThat(NowTokens.isTimeKey("timeout")).isFalse()
        assertThat(NowTokens.isTimeKey("nowhere")).isFalse()
        assertThat(NowTokens.isZone("UTC")).isTrue()
        assertThat(NowTokens.isZone("Asia/Seoul")).isTrue()
        assertThat(NowTokens.isZone("n1")).isFalse()
        assertThat(NowTokens.isZone("body")).isFalse()
        assertThat(NowTokens.resolve("now:j", null, at)).isNull()      // 알 수 없는 패턴 글자
        assertThat(NowTokens.resolve("orderId", null, at)).isNull()    // 시각 토큰 아님
        assertThat(NowTokens.resolveExpr("now:yyyyMMdd@UTC", at)).isEqualTo("20260909")
        assertThat(NowTokens.resolveExpr("time@body", at)).isNull()    // 소스 참조
        assertThat(NowTokens.resolveExpr("now:j", at)).isEqualTo("")   // 시각 토큰이지만 해석 불가 → 빈 값
    }
}
