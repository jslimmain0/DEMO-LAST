package com.flowlink.mock

import com.fasterxml.jackson.databind.ObjectMapper
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

/**
 * 사용자 정의 mock 라우트 실행기(순수 — 저장소/HTTP 의존 없음).
 *
 * 매칭: 정의 순서대로 method+경로 패턴(`/users/{id}`) 첫 매칭 라우트 → 그 안에서 조건(AND) 만족 첫 규칙.
 * 렌더: 규칙의 본문/헤더/setState/콜백 템플릿을 [MockTemplate] 문맥(요청·경로·seq·상태·시크릿)으로 해석.
 * 템플릿 문법은 [MockTemplate] — `{{ x@body }}`(칩) 와 `{{body.x}}`(dot) 둘 다, `{{ 이름@secret }}` 포함.
 * 미해석 토큰은 빈 문자열(워크플로 바인딩 `{{ key@node }}` 와는 다른 문맥).
 */
@Component
class MockRuntime {

    /** 매칭 결과 — [req] 는 라우트 코덱(prepare)까지 적용된 요청(조건·템플릿이 본 그대로). */
    data class Match(val rule: MockRule, val pathParams: Map<String, String>, val req: MockRequest)

    /** 응답 후 코덱 훅 — 렌더된 본문 + (기록 가능한) 헤더 + 규칙 contentType → 최종 본문. */
    fun interface ResponseCodec {
        fun apply(body: String, headers: MutableMap<String, String>, contentType: String?): String
    }

    /**
     * 정의 순서대로 method+경로 첫 매칭 라우트, 그 안에서 조건 만족 첫 규칙.
     * [prepare] 는 경로/메서드가 맞은 라우트에 대해 조건 평가 **전** 요청을 바꿀 기회(요청 코덱 — 본문 디코딩).
     */
    fun match(
        routes: List<MockRoute>, req: MockRequest, state: Map<String, String> = emptyMap(), hits: Map<String, Int> = emptyMap(),
        prepare: ((MockRoute, MockRequest) -> MockRequest)? = null
    ): Optional<Match> {
        for (route in routes) {
            val params = matchPath(route.path, req.path) ?: continue
            val m = if (route.method == null) "ANY" else route.method.uppercase(Locale.ROOT)
            if (m != "ANY" && m != req.method) {
                continue
            }
            val r = if (prepare == null) req else prepare(route, req)
            for (rule in route.rulesOrEmpty()) {
                // 순차 응답: repeat 소진(처음 N회 매칭 후)이면 이 규칙은 건너뛰고 다음 규칙으로 폴스루
                if (rule.repeat != null && rule.id != null && (hits[rule.id] ?: 0) >= rule.repeat) {
                    continue
                }
                if (conditionsPass(rule.whenOrEmpty(), r, params, state)) {
                    return Optional.of(Match(rule, params, r))
                }
            }
            // 경로는 맞지만 규칙 무매칭 — 다음 라우트로 넘기지 않고 404 (같은 경로 중복 정의 혼란 방지)
            return Optional.empty()
        }
        return Optional.empty()
    }

    /**
     * 규칙 → 실제 응답(바이트) + 지연 + 콜백 명세. seq 는 서버별 증가 카운터 공급자에서 받은 값.
     * [responseCodec] 은 템플릿 렌더가 끝난 본문 전체에 적용(응답 코덱 — 문자셋 인코딩 직전, 헤더 기록 가능). 콜백 본문에는 미적용.
     * [secrets] 는 `{{ 이름@secret }}` 해석용(게이트웨이가 Mock 시크릿 환경으로 조회), [json] 은 본문 점 경로 토큰용.
     */
    fun render(
        rule: MockRule, req: MockRequest, pathParams: Map<String, String>, seq: Long, state: Map<String, String> = emptyMap(),
        responseCodec: ResponseCodec? = null, secrets: Map<String, String> = emptyMap(), json: ObjectMapper? = null
    ): MockResponse {
        val ctx = MockContext(req = req, pathParams = pathParams, seq = seq, state = state, secrets = secrets, json = json)
        val cs = MockHttp.charsetOf(rule.charset)
        val rendered = MockTemplate.render(rule.body ?: "", ctx)
        val headers = LinkedHashMap<String, String>()
        for (kv in rule.headers ?: emptyList()) {
            if (kv.key != null && kv.key.isNotBlank()) {
                headers[kv.key] = MockTemplate.render(kv.value ?: "", ctx)
            }
        }
        val body = if (responseCodec == null) rendered else responseCodec.apply(rendered, headers, rule.contentType)
        // 상태 있는 목: setState 의 값을 템플릿 해석해 서버 상태에 반영할 맵으로(게이트웨이가 적용).
        // op=incr/decr 은 현재 상태값을 숫자로 누산(재고·잔액 원장 시뮬레이션). set(기본)은 대입.
        val newState = LinkedHashMap<String, String>()
        for (kv in rule.setState ?: emptyList()) {
            if (kv.key == null || kv.key.isBlank()) continue
            val v = MockTemplate.render(kv.value ?: "", ctx)
            newState[kv.key] = when (kv.op?.lowercase(Locale.ROOT)) {
                "incr" -> ((state[kv.key]?.toLongOrNull() ?: 0L) + (v.toLongOrNull() ?: 1L)).toString()
                "decr" -> ((state[kv.key]?.toLongOrNull() ?: 0L) - (v.toLongOrNull() ?: 1L)).toString()
                else -> v
            }
        }
        val delay = if (rule.delayMs == null) 0 else Math.max(0, Math.min(rule.delayMs, MAX_DELAY_MS))
        var cb: FiredCallback? = null
        val c = rule.callback
        if (c != null) {
            val url = MockTemplate.render(c.url ?: "", ctx).trim()
            if (url.isNotEmpty()) {
                cb = FiredCallback(
                    if (c.afterMs == null) 0 else Math.max(0, Math.min(c.afterMs, MAX_CALLBACK_DELAY_MS)),
                    url,
                    if (c.method == null || c.method.isBlank()) "POST" else c.method.uppercase(Locale.ROOT),
                    MockHttp.contentTypeHeader(
                        if (c.contentType == null || c.contentType.isBlank()) "urlencoded" else c.contentType,
                        StandardCharsets.UTF_8
                    ),
                    MockTemplate.render(c.body ?: "", ctx),
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

    // ---------- 템플릿(호환 편의) ----------

    fun template(text: String?, req: MockRequest, pathParams: Map<String, String>, seq: Long, state: Map<String, String> = emptyMap()): String =
        MockTemplate.render(text, MockContext(req = req, pathParams = pathParams, seq = seq, state = state))

    companion object {
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
            val ctx = MockContext(req = req, pathParams = pathParams, state = state)
            for (c in conds) {
                val actual = MockTemplate.valueOf(c.source, c.key, ctx)
                val op = if (c.op == null) "eq" else c.op.lowercase(Locale.ROOT)
                val cv = c.value ?: ""
                val pass = when (op) {
                    "eq" -> actual != null && actual == cv
                    "ne" -> actual == null || actual != cv
                    "exists" -> actual != null && actual.isNotEmpty()
                    "contains" -> actual != null && actual.contains(cv)
                    "startswith" -> actual != null && actual.startsWith(cv)
                    "endswith" -> actual != null && actual.endsWith(cv)
                    "gt", "gte", "lt", "lte" -> numCompare(actual, cv, op)
                    "regex" -> actual != null && try { Regex(cv).containsMatchIn(actual) } catch (e: Exception) { false }
                    else -> false
                }
                if (!pass) {
                    return false
                }
            }
            return true
        }

        /** 숫자 비교(gt/gte/lt/lte) — 양변이 숫자가 아니면 false. */
        private fun numCompare(actual: String?, value: String, op: String): Boolean {
            val a = actual?.toDoubleOrNull() ?: return false
            val b = value.toDoubleOrNull() ?: return false
            return when (op) { "gt" -> a > b; "gte" -> a >= b; "lt" -> a < b; "lte" -> a <= b; else -> false }
        }
    }
}
