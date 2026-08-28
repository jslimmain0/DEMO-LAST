package com.flowlink.execution.engine

import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.Binding
import com.flowlink.core.graph.NodeField
import org.springframework.stereotype.Component
import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * 바인딩/토큰 해석기 — 프로토타입의 ctxResolve/ctxTokens/fieldVal 의미를 서버에서 재현한다.
 *
 * <p>토큰 형태: {@code {{ key }}}(bare, 가장 가까운 상위), {@code {{ key@sourceId }}}(명시),
 * {@code {{ key@req:sourceId }}}(요청값 스코프).
 */
@Component
class TokenResolver(private val json: JsonService) {

    /** 바인딩 값을 그대로(원형 객체로) 해석. 중첩 경로(user.name·items[0].id)도 지원. */
    fun resolveBinding(b: Binding?, ctx: ExecutionContext): Any? {
        if (b == null) {
            return null
        }
        val key = b.key ?: return null
        val src = ctx.raw((if (b.isRequestScope()) "req:" else "") + b.sourceId)
        val v = dig(src, key)
        return if (v === Missing) null else v
    }

    /**
     * 필드 값 — 바인딩이면 그 값, 아니면 {{토큰}} 치환된 리터럴.
     * 리터럴이 <b>정확히 토큰 하나</b>면 원형(숫자/불리언/객체)으로 해석한다 — 구(舊) bound 바인딩이
     * 토큰 문자열로 이관돼도 타입이 보존되도록(bound 와 동일 의미). 텍스트가 섞이면 문자열 치환.
     */
    fun fieldValue(f: NodeField, ctx: ExecutionContext): Any? {
        if (f.bound != null) {
            return resolveBinding(f.bound, ctx)
        }
        val v = f.value ?: return null
        if (!v.contains("{{")) {
            return v
        }
        return resolveLiteral(v, ctx)
    }

    /** 리터럴 해석 — 전체가 토큰 하나면 원형 객체, 아니면 문자열 치환. (SET 변수·필드 값 공용) */
    fun resolveLiteral(value: String, ctx: ExecutionContext): Any? {
        val m = TOKEN.matcher(value.trim())
        if (m.matches()) {
            return resolveTokenObject(m.group(1), m.group(2) != null, m.group(3), ctx)
        }
        return resolveTokens(value, ctx)
    }

    /** 문자열 내 {{토큰}}을 모두 치환. 해석 실패 토큰은 빈 문자열로. */
    fun resolveTokens(str: String?, ctx: ExecutionContext): String {
        if (str == null || str.isEmpty()) {
            return str ?: ""
        }
        val m = TOKEN.matcher(str)
        val sb = StringBuilder()
        while (m.find()) {
            val key = m.group(1)
            val req = m.group(2) != null
            val srcId = m.group(3)
            val replacement: String? = if (srcId != null) {
                pickVal(ctx.raw((if (req) "req:" else "") + srcId), key)
            } else {
                nearestUpstream(key, ctx)
            }
            m.appendReplacement(sb, Matcher.quoteReplacement(replacement ?: ""))
        }
        m.appendTail(sb)
        return sb.toString()
    }

    /** IF 표현식 평가용 — 토큰을 (문자열이 아닌) 원형 객체로 해석한다. 없거나 null이면 null. */
    fun resolveTokenObject(key: String, req: Boolean, srcId: String?, ctx: ExecutionContext): Any? {
        if (srcId != null) {
            return pickObject(ctx.raw((if (req) "req:" else "") + srcId), key)
        }
        for (k in ctx.keysReversed()) {
            if (k.startsWith("req:")) {
                continue
            }
            val o = pickObject(ctx.raw(k), key)
            if (o != null) {
                return o
            }
        }
        return null
    }

    private fun pickObject(obj: Any?, key: String): Any? {
        val v = dig(obj, key)
        return if (v === Missing) null else v
    }

    /** 경로 탐색 실패 표식 — '값이 null 로 존재'와 '키 부재'를 구분한다(부재면 상위 노드 계속 탐색). */
    private object Missing

    /**
     * 중첩 경로 탐색 — JSON 안의 JSON 을 {@code user.name}·{@code items[0].id} 경로로 꺼낸다.
     * <b>평평한 실키 우선</b>: 응답에 {@code "user.name"} 이라는 키가 문자 그대로 있으면 그것을 쓴다(호환).
     * 배열은 숫자 세그먼트로 인덱싱({@code items[0]} = {@code items.0}). 부재/타입 불일치는 [Missing].
     */
    private fun dig(obj: Any?, key: String): Any? {
        // 최상위가 배열인 응답: `[1].id` 처럼 [ 로 시작하는 경로는 배열 자체에서 인덱싱하고,
        // 일반 키는 기존 규약(첫 원소에서 조회)을 유지한다.
        val rootIndexed = key.startsWith("[")
        val base = if (obj is List<*> && !rootIndexed) (if (obj.isEmpty()) return Missing else obj[0]) else obj
        if (base is Map<*, *> && base.containsKey(key)) {
            return base[key]
        }
        if (!key.contains('.') && !key.contains('[')) {
            return Missing
        }
        var cur: Any? = base
        for (seg in splitPath(key)) {
            // 값이 JSON "문자열"(이중 인코딩 — 레거시 API 의 json-in-json)이고 경로가 남았으면 파싱해 계속 내려간다
            if (cur is String) {
                val t = cur.trim()
                if (!t.startsWith("{") && !t.startsWith("[")) return Missing
                cur = runCatching { json.mapper().readValue(t, Any::class.java) }.getOrNull() ?: return Missing
            }
            cur = when {
                cur is Map<*, *> && cur.containsKey(seg) -> cur[seg]
                cur is List<*> -> {
                    val i = seg.toIntOrNull() ?: return Missing
                    if (i < 0 || i >= cur.size) return Missing
                    cur[i]
                }
                else -> return Missing
            }
        }
        return cur
    }

    private fun splitPath(key: String): List<String> =
        key.replace("]", "").split('.', '[').filter { it.isNotEmpty() }

    private fun nearestUpstream(key: String, ctx: ExecutionContext): String? {
        for (k in ctx.keysReversed()) {
            if (k.startsWith("req:")) {
                continue
            }
            val v = pickVal(ctx.raw(k), key)
            if (v != null) {
                return v
            }
        }
        return null
    }

    /** 객체(또는 배열의 첫 원소)에서 key(중첩 경로 가능) 값을 문자열로 추출. */
    fun pickVal(obj: Any?, key: String): String? {
        val v = dig(obj, key)
        return if (v === Missing) null else stringify(v)
    }

    /** ctx 값들을 헤더/쿼리/바디에 넣기 위한 문자열화. */
    fun stringify(v: Any?): String {
        if (v == null) {
            return ""
        }
        if (v is String) {
            return v
        }
        if (v is Number || v is Boolean) {
            return v.toString()
        }
        return json.toJson(v) // 객체/배열은 JSON 문자열로
    }

    companion object {
        // key 클래스에 한글 포함(응답 키가 한글인 API) + 중첩 경로 문자(. [ ] — items[0].id) · sourceId 클래스 [\w-].
        // 프론트 lib/tokenGrammar.ts 와 1:1 미러 — 같이 바꿀 것.
        private val TOKEN: Pattern =
            Pattern.compile("\\{\\{\\s*([\\w.\\[\\]가-힣-]+)(?:@(req:)?([\\w-]+))?\\s*}}")

        @JvmStatic
        fun tokenPattern(): Pattern = TOKEN
    }
}
