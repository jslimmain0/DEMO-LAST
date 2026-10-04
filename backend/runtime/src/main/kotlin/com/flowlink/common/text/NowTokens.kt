package com.flowlink.common.text

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * 현재 일시 토큰 — Mock 템플릿과 워크플로 토큰이 공유하는 순수 해석기.
 *
 *  - `now`            ISO-8601 UTC(`2026-09-09T05:04:05.123Z`, 기존 규약 그대로)
 *  - `now:패턴`       Java DateTimeFormatter 패턴(`yyyyMMddHHmmss`, `yyyy-MM-dd HH:mm:ss`, `a h시`) — 기본 타임존 KST
 *  - `today`          `yyyyMMdd` (KST)  · `time` `HHmmss` (KST)
 *  - `@타임존`        `now:yyyyMMdd@UTC`, `today@UTC`, `now@Asia/Seoul`(패턴 없으면 그 타임존 ISO 오프셋 표기)
 *
 * 워크플로에선 `@` 뒤가 노드 id 인지 타임존인지 [isZone] 으로 구분한다(노드 id 는 ZoneId 가 아니다).
 * 잘못된 패턴은 null(호출처가 빈 문자열로 처리).
 */
object NowTokens {
    const val DEFAULT_ZONE = "Asia/Seoul"
    private val HEAD = Regex("^(now|today|time)(?::(.*))?$", RegexOption.DOT_MATCHES_ALL)

    /** 시각 토큰 키인가 — `now` / `now:패턴` / `today` / `time`. */
    @JvmStatic
    fun isTimeKey(key: String?): Boolean = key != null && HEAD.matches(key.trim())

    /** 패턴이 붙은 형태인가(`now:yyyyMMdd`) — bare 이름은 상위 노드 출력이 먼저지만 패턴형은 항상 시각. */
    @JvmStatic
    fun hasPattern(key: String?): Boolean = key != null && key.contains(':')

    /** 타임존 id 인가(`UTC`·`GMT`·`Z`·`+09:00`·`Asia/Seoul`) — 워크플로 `@노드id` 와 구분. */
    @JvmStatic
    fun isZone(id: String?): Boolean = id != null && zoneOf(id) != null

    private fun zoneOf(id: String): ZoneId? = try { ZoneId.of(id.trim()) } catch (e: Exception) { null }

    /**
     * 해석 — 시각 토큰이 아니면 null, 잘못된 패턴/타임존이면 null.
     * @param key  `now` | `now:패턴` | `today` | `time`
     * @param zone null=KST, 아니면 ZoneId 문자열
     */
    @JvmStatic
    fun resolve(key: String, zone: String? = null, at: Instant = Instant.now()): String? {
        val m = HEAD.find(key.trim()) ?: return null
        val name = m.groupValues[1]
        val pattern = m.groupValues[2].takeIf { it.isNotBlank() }
        val z = if (zone == null) ZoneId.of(DEFAULT_ZONE) else (zoneOf(zone) ?: return null)
        val p = pattern ?: when (name) { "today" -> "yyyyMMdd"; "time" -> "HHmmss"; else -> null }
        if (p == null) {
            // `now` 단독 — 타임존 없으면 ISO UTC(기존), 있으면 그 타임존의 ISO 오프셋 표기
            return if (zone == null) at.toString() else DateTimeFormatter.ISO_OFFSET_DATE_TIME.withZone(z).format(at)
        }
        return try { DateTimeFormatter.ofPattern(p, Locale.KOREA).withZone(z).format(at) } catch (e: Exception) { null }
    }

    /** `키@타임존` 한 덩어리 해석(Mock 템플릿용) — 시각 토큰이 아니면 null, 잘못된 패턴/타임존이면 빈 문자열. */
    @JvmStatic
    fun resolveExpr(expr: String, at: Instant = Instant.now()): String? {
        val t = expr.trim()
        val at2 = t.lastIndexOf('@')
        val key = if (at2 > 0) t.substring(0, at2).trim() else t
        val zone = if (at2 > 0) t.substring(at2 + 1).trim() else null
        if (!isTimeKey(key)) return null
        if (zone != null && !isZone(zone)) return null // `time@body` 같은 소스 참조는 시각 토큰이 아님
        return resolve(key, zone, at) ?: ""
    }
}
