package com.flowlink.mock

import com.flowlink.mock.MockHttp.FiredCallback
import com.flowlink.mock.MockHttp.MockRequest
import com.flowlink.mock.MockHttp.MockResponse
import com.flowlink.mock.MockSpec.MockCond
import com.flowlink.mock.MockSpec.MockRoute
import com.flowlink.mock.MockSpec.MockRule
import org.springframework.stereotype.Component
import java.nio.charset.StandardCharsets
import java.util.LinkedHashMap
import java.util.Locale
import java.util.Optional
import java.util.UUID
import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * CUSTOM mock 서버의 순수 런타임 — 라우트 매칭·조건 평가·템플릿 렌더.
 * 상태가 없어 단위 테스트 대상. (콜백 "발사"는 [MockCallbackDispatcher]가 담당)
 *
 * 템플릿 토큰(응답 body·헤더 값·콜백 url/body):
 * `{{path.x}} {{query.x}} {{header.x}} {{body.x}} {{body}} {{method}} {{uuid}} {{seq}} {{now}}`
 * — 미해석 토큰은 빈 문자열. (워크플로 바인딩 `{{ key@node }}` 와는 다른 문맥)
 */
@Component
class MockRuntime {

    /** 매칭 결과 — 규칙·경로 파라미터. */
    data class Match(val rule: MockRule, val pathParams: Map<String, String>)

    /** 정의 순서대로 method+경로 첫 매칭 라우트, 그 안에서 조건 만족 첫 규칙. */
    fun match(routes: List<MockRoute>, req: MockRequest, state: Map<String, String> = emptyMap()): Optional<Match> {
        for (route in routes) {
            val params = matchPath(route.path, req.path) ?: continue
            val m = if (route.method == null) "ANY" else route.method.uppercase(Locale.ROOT)
            if (m != "ANY" && m != req.method) {
                continue
            }
            for (rule in route.rulesOrEmpty()) {
                if (conditionsPass(rule.whenOrEmpty(), req, params, state)) {
                    return Optional.of(Match(rule, params))
                }
            }
            // 경로는 맞지만 규칙 무매칭 — 다음 라우트로 넘기지 않고 404 (같은 경로 중복 정의 혼란 방지)
            return Optional.empty()
        }
        return Optional.empty()
    }

    /** 규칙 → 실제 응답(바이트) + 지연 + 콜백 명세. seq 는 서버별 증가 카운터 공급자에서 받은 값. */
    fun render(rule: MockRule, req: MockRequest, pathParams: Map<String, String>, seq: Long, state: Map<String, String> = emptyMap()): MockResponse {
        val cs = MockHttp.charsetOf(rule.charset)
        val body = template(if (rule.body == null) "" else rule.body, req, pathParams, seq, state)
        val headers = LinkedHashMap<String, String>()
        for (kv in rule.headers ?: emptyList()) {
            if (kv.key != null && kv.key.isNotBlank()) {
                headers[kv.key] = template(if (kv.value == null) "" else kv.value, req, pathParams, seq, state)
            }
        }
        // 상태 있는 목: setState 의 값을 템플릿 해석해 서버 상태에 반영할 맵으로(게이트웨이가 적용)
        val newState = LinkedHashMap<String, String>()
        for (kv in rule.setState ?: emptyList()) {
            if (kv.key != null && kv.key.isNotBlank()) {
                newState[kv.key] = template(if (kv.value == null) "" else kv.value, req, pathParams, seq, state)
            }
        }
        val delay = if (rule.delayMs == null) 0 else Math.max(0, Math.min(rule.delayMs, MAX_DELAY_MS))
        var cb: FiredCallback? = null
        val c = rule.callback
        if (c != null) {
            val url = template(if (c.url == null) "" else c.url, req, pathParams, seq, state).trim()
            if (url.isNotEmpty()) {
                cb = FiredCallback(
                    if (c.afterMs == null) 0 else Math.max(0, Math.min(c.afterMs, MAX_CALLBACK_DELAY_MS)),
                    url,
                    if (c.method == null || c.method.isBlank()) "POST" else c.method.uppercase(Locale.ROOT),
                    MockHttp.contentTypeHeader(
                        if (c.contentType == null || c.contentType.isBlank()) "urlencoded" else c.contentType,
                        StandardCharsets.UTF_8
                    ),
                    template(if (c.body == null) "" else c.body, req, pathParams, seq, state),
                    c.retryUntilOk == true
                )
            }
        }
        val status = rule.status ?: 200
        return MockResponse(
            status, MockHttp.contentTypeHeader(rule.contentType, cs), headers,
            body.toByteArray(cs), delay, cb, newState
        )
    }

    // ---------- 템플릿 ----------

    fun template(text: String?, req: MockRequest, pathParams: Map<String, String>, seq: Long, state: Map<String, String> = emptyMap()): String {
        if (text == null || text.isEmpty() || !text.contains("{{")) {
            return text ?: ""
        }
        val m = TOKEN.matcher(text)
        val sb = StringBuilder()
        while (m.find()) {
            m.appendReplacement(sb, Matcher.quoteReplacement(resolve(m.group(1), req, pathParams, seq, state)))
        }
        m.appendTail(sb)
        return sb.toString()
    }

    private fun resolve(token: String, req: MockRequest, pathParams: Map<String, String>, seq: Long, state: Map<String, String> = emptyMap()): String {
        val t = token.trim()
        val v: String? = when (t) {
            "uuid" -> UUID.randomUUID().toString()
            "seq" -> seq.toString()
            "now" -> java.time.Instant.now().toString()
            "method" -> req.method
            "body" -> req.bodyText
            else -> null
        }
        if (v != null) {
            return v
        }
        val dot = t.indexOf('.')
        if (dot > 0 && dot < t.length - 1) {
            val src = t.substring(0, dot)
            val key = t.substring(dot + 1)
            val got = valueOf(src, key, req, pathParams, state)
            return got ?: ""
        }
        return "" // 미해석 토큰 — 빈 문자열
    }

    companion object {
        private val TOKEN: Pattern = Pattern.compile("\\{\\{\\s*(.+?)\\s*}}")
        const val MAX_DELAY_MS = 10_000
        const val MAX_CALLBACK_DELAY_MS = 60_000

        // ---------- 경로 매칭 ----------

        /** /users/{id} 패턴 매칭. 매칭되면 경로 파라미터 맵(빈 맵 가능), 아니면 null. */
        @JvmStatic
        fun matchPath(pattern: String?, actual: String?): Map<String, String>? {
            if (pattern == null || pattern.isBlank()) {
                return null
            }
            val ps = normalize(pattern).split("/")
            val ac = normalize(actual).split("/")
            if (ps.size != ac.size) {
                return null
            }
            val params = LinkedHashMap<String, String>()
            for (i in ps.indices) {
                val p = ps[i]
                if (p.length >= 2 && p.startsWith("{") && p.endsWith("}")) {
                    if (ac[i].isEmpty()) {
                        return null
                    }
                    params[p.substring(1, p.length - 1)] = ac[i]
                } else if (p != ac[i]) {
                    return null
                }
            }
            return params
        }

        private fun normalize(path: String?): String {
            var p = path?.trim() ?: ""
            if (!p.startsWith("/")) {
                p = "/$p"
            }
            if (p.length > 1 && p.endsWith("/")) {
                p = p.substring(0, p.length - 1)
            }
            return p
        }

        // ---------- 조건 ----------

        @JvmStatic
        fun conditionsPass(conds: List<MockCond>, req: MockRequest, pathParams: Map<String, String>, state: Map<String, String> = emptyMap()): Boolean {
            for (c in conds) {
                val actual = valueOf(c.source, c.key, req, pathParams, state)
                val op = if (c.op == null) "eq" else c.op.lowercase(Locale.ROOT)
                val pass = when (op) {
                    "eq" -> actual != null && actual == (c.value ?: "")
                    "ne" -> actual == null || actual != (c.value ?: "")
                    "exists" -> actual != null && actual.isNotEmpty()
                    "contains" -> actual != null && actual.contains(c.value ?: "")
                    else -> false
                }
                if (!pass) {
                    return false
                }
            }
            return true
        }

        private fun valueOf(source: String?, key: String?, req: MockRequest, pathParams: Map<String, String>, state: Map<String, String> = emptyMap()): String? {
            if (key == null) {
                return null
            }
            val src = source?.lowercase(Locale.ROOT) ?: ""
            return when (src) {
                "query" -> req.query[key]
                "header" -> req.headers[key.lowercase(Locale.ROOT)]
                "body" -> req.bodyFields[key]
                "path" -> pathParams[key]
                "state" -> state[key] // 상태 있는 목 — 이전 호출이 setState 한 값
                else -> null
            }
        }
    }
}
