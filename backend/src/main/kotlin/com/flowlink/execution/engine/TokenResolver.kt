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

    /** 바인딩 값을 그대로(원형 객체로) 해석. */
    fun resolveBinding(b: Binding?, ctx: ExecutionContext): Any? {
        if (b == null) {
            return null
        }
        var src = ctx.raw((if (b.isRequestScope()) "req:" else "") + b.sourceId)
        if (src is List<*>) {
            src = if (src.isEmpty()) null else src[0]
        }
        if (src is Map<*, *>) {
            return src[b.key]
        }
        return null
    }

    /** 필드 값 — 바인딩이면 그 값, 아니면 {{토큰}} 치환된 리터럴. */
    fun fieldValue(f: NodeField, ctx: ExecutionContext): Any? {
        if (f.bound != null) {
            return resolveBinding(f.bound, ctx)
        }
        val v = f.value
        return if (v != null && v.contains("{{")) resolveTokens(v, ctx) else v
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
        val base = if (obj is List<*>) (if (obj.isEmpty()) null else obj[0]) else obj
        if (base is Map<*, *> && base.containsKey(key)) {
            return base[key]
        }
        return null
    }

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

    /** 객체(또는 배열의 첫 원소)에서 key 값을 문자열로 추출. */
    fun pickVal(obj: Any?, key: String): String? {
        val base = if (obj is List<*>) (if (obj.isEmpty()) null else obj[0]) else obj
        if (base is Map<*, *> && base.containsKey(key)) {
            return stringify(base[key])
        }
        return null
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
        private val TOKEN: Pattern =
            Pattern.compile("\\{\\{\\s*([\\w.-]+)(?:@(req:)?([A-Za-z0-9]+))?\\s*}}")

        @JvmStatic
        fun tokenPattern(): Pattern = TOKEN
    }
}
