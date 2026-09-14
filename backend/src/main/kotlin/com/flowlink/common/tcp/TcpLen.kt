package com.flowlink.common.tcp

import java.nio.charset.Charset
import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * 전문 길이 토큰 — **전문 안에 들어가는 전문길이 필드**를 손으로 안 쓰게 자동으로 채운다.
 * 워크플로 TCP 노드(요청 필드 값)와 TCP mock(응답 필드 값·응답 템플릿)이 **같은 문법**을 쓰도록 공용 순수 객체.
 *
 * 문법(소문자 고정 — `now/today/time` 과 같은 규약):
 *  - `{{len}}`          본문(프리픽스 제외) 바이트 수, 10진수 그대로 (예: `204`)
 *  - `{{len:N}}`        같은 값을 N 자리 0 패딩 (예: `{{len:4}}` → `0204`)
 *  - `{{len:frame}}`    프리픽스 포함 전체 전송 바이트 수(본문 + 프리픽스 폭)
 *  - `{{len:frame:N}}`  위 값을 N 자리 0 패딩
 * 공백은 허용(`{{ len : frame : 4 }}`). **알 수 없는 형태는 건드리지 않는다**(`{{length}}`·`{{len:x}}` 는 원문 유지).
 *
 * 길이를 알아내는 방법(순환 없음):
 *  - **필드 모드**(노드 요청 필드 / mock 응답 필드): 모든 필드가 고정길이라 본문 길이 = **선언 길이의 합**. [resolve] 로 바로 치환.
 *  - **템플릿 모드**(mock 규칙의 `response` 문자열, responseFields 가 비었을 때): 선언 합이 없으므로 [resolveRendered] 의
 *    **2패스**(자리표시자 `0` 으로 폭만 확정 → 바이트 길이 측정 → 실제 숫자로 재치환)로 구한다.
 *    자리표시자와 최종 숫자의 **폭이 같아야** 길이가 안 변하므로:
 *      · `:N` 형태는 항상 N 자리(넘치면 [TcpBytes.prefix] 와 같이 **하위 N 자리**만 — 폭 불변),
 *      · bare 형태는 결과와 일관된 자릿수(`w = digits(본문길이)`)를 **고정점**으로 찾는다(자릿수를 늘리면 본문도 길어지므로 단조 — 몇 번이면 수렴).
 *
 * 프리픽스 의미: `frame` = 본문 + 프리픽스 폭(프리픽스 바이트가 실제로 앞에 붙으므로). 프리픽스가 없으면(`prefixLength<=0`) `frame` = `{{len}}`.
 * ⚠ `prefixIncludesSelf=false` 인 mock/노드에서 **프리픽스에 쓰이는 숫자**는 본문 길이 = `{{len}}` 이다(`frame` 이 아니다).
 */
object TcpLen {

    /** `{{len}}` / `{{len:N}}` / `{{len:frame}}` / `{{len:frame:N}}` — 그룹 1=frame 여부, 2=자리수. */
    private val TOKEN: Pattern =
        Pattern.compile("\\{\\{\\s*len(?:\\s*:\\s*(frame))?(?:\\s*:\\s*(\\d{1,3}))?\\s*}}")

    /** 토큰 안쪽 텍스트(중괄호 제외)가 길이 토큰인가 — MockTemplate 이 원문 보존 여부를 판단할 때. */
    private val INNER: Pattern =
        Pattern.compile("^len(?:\\s*:\\s*(?:frame))?(?:\\s*:\\s*\\d{1,3})?$")

    /** 고정점 탐색 상한(이론상 2~3회면 수렴 — 방어적). */
    private const val MAX_PASSES = 8

    @JvmStatic
    fun hasToken(text: String?): Boolean = text != null && text.contains("{{") && TOKEN.matcher(text).find()

    /** 토큰 안쪽 텍스트(`len:4` 등)가 길이 토큰인가. */
    @JvmStatic
    fun isToken(inner: String?): Boolean = inner != null && INNER.matcher(inner.trim()).matches()

    /**
     * 길이가 이미 확정된 경우(선언 길이 합)의 치환.
     * @param bodyLen  본문(프리픽스 제외) 바이트 수
     * @param frameLen 프리픽스 포함 전체 바이트 수(= bodyLen + 프리픽스 폭)
     */
    @JvmStatic
    fun resolve(text: String?, bodyLen: Int, frameLen: Int): String {
        if (text.isNullOrEmpty() || !text.contains("{{")) return text ?: ""
        return substitute(text) { frame, width ->
            val v = if (frame) frameLen else bodyLen
            format(v, width ?: digits(v))
        }
    }

    /**
     * 템플릿 모드 2패스 — **다른 토큰이 이미 렌더된** 본문 문자열에서 길이 토큰을 확정한다.
     * (다른 토큰을 두 번 렌더하면 `{{uuid}}`·`{{now}}` 처럼 매번 달라지는 값 때문에 길이가 흔들리므로, 렌더는 한 번만 하고 여기서 폭만 맞춘다.)
     * @param prefixLen 프리픽스 폭(0 이면 `frame` = 본문 길이)
     */
    @JvmStatic
    fun resolveRendered(rendered: String?, prefixLen: Int, cs: Charset): String {
        if (rendered.isNullOrEmpty() || !hasToken(rendered)) return rendered ?: ""
        val pre = maxOf(prefixLen, 0)
        var wBody = 1
        var wFrame = 1
        repeat(MAX_PASSES) {
            val body = measure(rendered, wBody, wFrame, cs)
            val nb = digits(body)
            val nf = digits(body + pre)
            if (nb == wBody && nf == wFrame) {
                return fill(rendered, body, body + pre, wBody, wFrame) // 자리표시자와 폭이 같으므로 최종 바이트 길이 = body
            }
            wBody = nb
            wFrame = nf
        }
        val body = measure(rendered, wBody, wFrame, cs) // 수렴 실패(이론상 도달 불가) — 마지막 폭으로 마감
        return fill(rendered, body, body + pre, wBody, wFrame)
    }

    /** 1패스: 길이 토큰을 폭만큼의 `0` 으로 채워 본문 바이트 수를 잰다. */
    private fun measure(text: String, wBody: Int, wFrame: Int, cs: Charset): Int =
        substitute(text) { frame, width -> zeros(width ?: if (frame) wFrame else wBody) }.toByteArray(cs).size

    /** 2패스: 실제 숫자로(자리표시자와 같은 폭). */
    private fun fill(text: String, bodyLen: Int, frameLen: Int, wBody: Int, wFrame: Int): String =
        substitute(text) { frame, width ->
            val v = if (frame) frameLen else bodyLen
            format(v, width ?: if (frame) wFrame else wBody)
        }

    /** 토큰마다 (frame 여부, 자리수 또는 null) → 치환 문자열. */
    private fun substitute(text: String, f: (Boolean, Int?) -> String): String {
        val m = TOKEN.matcher(text)
        val sb = StringBuilder()
        while (m.find()) {
            val frame = m.group(1) != null
            val width = m.group(2)?.toIntOrNull()
            m.appendReplacement(sb, Matcher.quoteReplacement(f(frame, width)))
        }
        m.appendTail(sb)
        return sb.toString()
    }

    /** [width] 자리 0 패딩 — 넘치면 하위 [width] 자리만(폭 불변, [TcpBytes.prefix] 와 같은 방어 규약). */
    private fun format(value: Int, width: Int): String {
        val w = maxOf(width, 1)
        val s = String.format("%0${w}d", maxOf(value, 0))
        return if (s.length > w) s.substring(s.length - w) else s
    }

    private fun zeros(width: Int): String = "0".repeat(maxOf(width, 1))

    private fun digits(v: Int): Int = if (v <= 0) 1 else v.toString().length
}
