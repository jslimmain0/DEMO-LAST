package com.flowlink.mock

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.flowlink.mock.MockHttp.MockRequest
import java.util.Locale
import java.util.UUID
import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * Mock 템플릿 문맥 — HTTP 요청·경로 파라미터·seq·상태·**시크릿**·TCP 요청 필드(프로토콜로 해석된 헤더+본문 값).
 * (환경 변수는 Mock 에 없음 — 시크릿만, Mock 별 시크릿 환경 스코프)
 * MockRuntime(응답/헤더/콜백/setState)·TcpMockSession(응답 필드)·MockCodec(입력값/파라미터)이 같은 문맥으로 렌더한다.
 */
class MockContext(
    val req: MockRequest? = null,
    val pathParams: Map<String, String> = emptyMap(),
    val seq: Long = 0L,
    val state: Map<String, String> = emptyMap(),
    val secrets: Map<String, String> = emptyMap(),
    val tcpFields: Map<String, String> = emptyMap(),
    val json: ObjectMapper? = null,
) {
    fun withReq(r: MockRequest): MockContext =
        MockContext(r, pathParams, seq, state, secrets, tcpFields, json)

    fun withTcp(fields: Map<String, String>): MockContext =
        MockContext(req, pathParams, seq, state, secrets, fields, json)
}

/**
 * Mock 통합 템플릿 — 두 문법을 모두 받는다.
 *  - 워크플로 문법(칩 호환): `{{ x@body }}` `{{ x@query }}` `{{ x@path }}` `{{ x@header }}` `{{ x@state }}` `{{ 이름@secret }}` `{{ x@req }}`(TCP)
 *  - dot 문법(기존): `{{body.x}}` `{{query.x}}` `{{path.x}}` `{{header.x}}` `{{state.x}}` `{{req.x}}` · `{{body}}` `{{method}}` `{{uuid}}` `{{seq}}` `{{now}}`
 *  - 현재 일시([NowTokens]): `{{ now }}`(ISO UTC) `{{ now:yyyyMMddHHmmss }}`(패턴, 기본 KST) `{{ today }}`(yyyyMMdd) `{{ time }}`(HHmmss) `{{ now:yyyyMMdd@UTC }}`(타임존)
 * body 키는 **점 경로**(`user.addr.city`, `items[0].id`)로 본문 JSON 을 파고들 수 있다(최상위 실키 우선).
 * 미해석 토큰은 빈 문자열(기존 규약 — 워크플로 바인딩과 다른 문맥).
 */
object MockTemplate {

    private val TOKEN: Pattern = Pattern.compile("\\{\\{\\s*([^{}]+?)\\s*}}")
    private val AT: Pattern = Pattern.compile("^([\\w.\\[\\]가-힣-]+)@(?:req:)?([\\w-]+)$")
    private val SOURCES = setOf("body", "query", "path", "header", "state", "secret", "req")

    @JvmStatic
    fun hasTokens(text: String?): Boolean = text != null && text.contains("{{")

    @JvmStatic
    fun render(text: String?, ctx: MockContext): String {
        if (text == null || text.isEmpty() || !text.contains("{{")) {
            return text ?: ""
        }
        val m = TOKEN.matcher(text)
        val sb = StringBuilder()
        while (m.find()) {
            m.appendReplacement(sb, Matcher.quoteReplacement(resolve(m.group(1), ctx)))
        }
        m.appendTail(sb)
        return sb.toString()
    }

    @JvmStatic
    fun resolve(rawToken: String, ctx: MockContext): String {
        val t = rawToken.trim()
        // 0) 현재 일시 — now / now:패턴 / today / time (+@타임존). `time@body` 같은 소스 참조는 시각 토큰이 아니라 아래로 흐른다
        com.flowlink.common.text.NowTokens.resolveExpr(t)?.let { return it }
        // 1) 워크플로 문법 key@source
        val at = AT.matcher(t)
        if (at.matches()) {
            val src = at.group(2).lowercase(Locale.ROOT)
            return if (src in SOURCES) valueOf(src, at.group(1), ctx) ?: "" else ""
        }
        // 2) bare 예약어
        when (t) {
            "uuid" -> return UUID.randomUUID().toString()
            "seq" -> return ctx.seq.toString()
            "method" -> return ctx.req?.method ?: ""
            "body" -> return ctx.req?.bodyText ?: ""
        }
        // 3) dot 문법 src.key
        val dot = t.indexOf('.')
        if (dot > 0 && dot < t.length - 1) {
            val src = t.substring(0, dot).lowercase(Locale.ROOT)
            if (src in SOURCES) return valueOf(src, t.substring(dot + 1), ctx) ?: ""
        }
        return ""
    }

    /** 소스별 값 — 조건 평가(MockRuntime.conditionsPass)와 공유. null=없음. */
    @JvmStatic
    fun valueOf(source: String?, key: String?, ctx: MockContext): String? {
        if (key == null) return null
        return when (source?.lowercase(Locale.ROOT) ?: "") {
            "query" -> ctx.req?.query?.get(key)
            "header" -> ctx.req?.headers?.get(key.lowercase(Locale.ROOT))
            "body" -> bodyValue(key, ctx)
            "path" -> ctx.pathParams[key]
            "state" -> ctx.state[key]
            "secret" -> ctx.secrets[key]
            "req" -> ctx.tcpFields[key]
            else -> null
        }
    }

    /** 본문 필드 — 최상위 실키 우선, 없으면 점 경로로 JSON 을 파고든다(값이 객체/배열이면 JSON 문자열). */
    private fun bodyValue(key: String, ctx: MockContext): String? {
        val req = ctx.req ?: return null
        req.bodyFields[key]?.let { return it }
        if (!(key.contains('.') || key.contains('['))) return null
        val mapper = ctx.json ?: return null
        val root = try { mapper.readTree(req.bodyText) } catch (e: Exception) { return null } ?: return null
        val node = JsonPaths.get(root, key) ?: return null
        return if (node.isValueNode) node.asText() else node.toString()
    }

    /** 점 경로(`a.b`, `items[0].id`) 조회/치환 — 코덱 fields 대상과 본문 토큰이 공유. */
    object JsonPaths {
        @JvmStatic
        fun segments(path: String): List<String> =
            path.replace("]", "").replace("[", ".").split('.').filter { it.isNotEmpty() }

        @JvmStatic
        fun get(root: JsonNode, path: String): JsonNode? {
            var cur: JsonNode = root
            for (seg in segments(path)) {
                cur = when {
                    cur.isObject -> cur.get(seg) ?: return null
                    cur.isArray -> seg.toIntOrNull()?.let { cur.get(it) } ?: return null
                    else -> return null
                }
            }
            return cur
        }

        /** 경로의 값을 문자열로 치환. 경로가 없으면 false(무시). */
        @JvmStatic
        fun setText(root: JsonNode, path: String, text: String): Boolean {
            val segs = segments(path)
            if (segs.isEmpty()) return false
            var parent: JsonNode = root
            for (seg in segs.dropLast(1)) {
                parent = when {
                    parent.isObject -> parent.get(seg) ?: return false
                    parent.isArray -> seg.toIntOrNull()?.let { parent.get(it) } ?: return false
                    else -> return false
                }
            }
            val last = segs.last()
            return when {
                parent is ObjectNode && parent.has(last) -> { parent.put(last, text); true }
                parent is ArrayNode -> { val i = last.toIntOrNull() ?: return false; if (i < 0 || i >= parent.size()) return false; parent.set(i, parent.textNode(text)); true }
                else -> false
            }
        }
    }
}
