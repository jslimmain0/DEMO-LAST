package com.flowlink.transform

import com.flowlink.transform.FlowTransform.IoSpec
import com.flowlink.transform.FlowTransform.TransformParam
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import java.util.regex.Pattern

/** 내장 변환 모음(샌드박스 불필요한 순수 문자열 변환). */
object BuiltinTransforms {

    fun all(): List<FlowTransform> = listOf(
        t(
            "split", "구분자로 분리 후 인덱스",
            listOf(TransformParam.of("delimiter", "구분자", ","), TransformParam.of("index", "인덱스", "0"))
        ) { input, c ->
            val parts = s(input).split(c.getOrDefault("delimiter", ","))
            val i = intOf(c["index"], 0)
            if (i >= 0 && i < parts.size) parts[i] else ""
        },
        t(
            "substring", "부분 문자열",
            listOf(TransformParam.of("start", "시작", "0"), TransformParam.of("end", "끝(빈값=끝까지)", ""))
        ) { input, c ->
            val str = s(input)
            val start = clamp(intOf(c["start"], 0), 0, str.length)
            val end = if (c.getOrDefault("end", "").isBlank()) str.length
            else clamp(intOf(c["end"], str.length), start, str.length)
            str.substring(start, end)
        },
        t("base64-encode", "Base64 인코딩", listOf()) { input, _ ->
            Base64.getEncoder().encodeToString(s(input).toByteArray(StandardCharsets.UTF_8))
        },
        t("base64-decode", "Base64 디코딩", listOf()) { input, _ ->
            try {
                String(Base64.getDecoder().decode(s(input)), StandardCharsets.UTF_8)
            } catch (e: IllegalArgumentException) {
                ""
            }
        },
        t("url-encode", "URL 인코딩", listOf()) { input, _ ->
            URLEncoder.encode(s(input), StandardCharsets.UTF_8)
        },
        t("url-decode", "URL 디코딩", listOf()) { input, _ ->
            URLDecoder.decode(s(input), StandardCharsets.UTF_8)
        },
        t("upper", "대문자", listOf()) { input, _ -> s(input).uppercase() },
        t("lower", "소문자", listOf()) { input, _ -> s(input).lowercase() },
        t("trim", "공백 제거", listOf()) { input, _ -> s(input).trim { it <= ' ' } },
        t(
            "replace", "정규식 치환",
            listOf(TransformParam.of("pattern", "정규식"), TransformParam.of("replacement", "치환값"))
        ) { input, c ->
            try {
                s(input).replace(c.getOrDefault("pattern", "").toRegex(), c.getOrDefault("replacement", ""))
            } catch (e: RuntimeException) {
                s(input)
            }
        },
        t(
            "regex-extract", "정규식 추출(그룹)",
            listOf(TransformParam.of("pattern", "정규식"), TransformParam.of("group", "그룹 번호", "1"))
        ) { input, c ->
            var result = ""
            try {
                val m = Pattern.compile(c.getOrDefault("pattern", "")).matcher(s(input))
                if (m.find()) {
                    val g = intOf(c["group"], 1)
                    result = if (g <= m.groupCount()) n(m.group(g)) else ""
                }
            } catch (ignored: RuntimeException) {
            }
            result
        },
        t("sha256", "SHA-256 해시(hex)", listOf()) { input, _ -> hash("SHA-256", s(input)) },
        t("md5", "MD5 해시(hex)", listOf()) { input, _ -> hash("MD5", s(input)) },

        // --- 멀티 입출력 예시 ---
        MultiTransform(
            "concat", "두 값 이어붙이기",
            listOf(IoSpec.of("a", "값1"), IoSpec.of("b", "값2")),
            listOf(IoSpec.of("result", "결과")),
            listOf()
        ) { inp, _ -> mapOf("result" to (s(inp["a"]) + s(inp["b"]))) },
        MultiTransform(
            "pair-split", "구분자로 둘로 분리",
            listOf(IoSpec.of("value", "입력")),
            listOf(IoSpec.of("first", "앞"), IoSpec.of("second", "뒤")),
            listOf(TransformParam.of("delimiter", "구분자", "="))
        ) { inp, c ->
            val p = s(inp["value"]).split(c.getOrDefault("delimiter", "="), limit = 2)
            mapOf("first" to (if (p.isNotEmpty()) p[0] else ""), "second" to (if (p.size > 1) p[1] else ""))
        }
    )

    private fun t(
        id: String, label: String, params: List<TransformParam>,
        fn: (String, Map<String, String>) -> String
    ): FlowTransform = SimpleTransform(id, label, params, fn)

    private fun s(v: String?): String = v ?: ""

    private fun n(v: String?): String = v ?: ""

    private fun intOf(v: String?, def: Int): Int {
        if (v == null) {
            return def
        }
        return try {
            v.trim().toInt()
        } catch (e: NumberFormatException) {
            def
        }
    }

    private fun clamp(v: Int, lo: Int, hi: Int): Int = maxOf(lo, minOf(v, hi))

    private fun hash(algo: String, input: String): String {
        return try {
            val md = MessageDigest.getInstance(algo)
            val digest = md.digest(input.toByteArray(StandardCharsets.UTF_8))
            val sb = StringBuilder(digest.size * 2)
            for (b in digest) {
                sb.append("%02x".format(b))
            }
            sb.toString()
        } catch (e: Exception) {
            ""
        }
    }

    /** 단일 입력("input") → 단일 출력("result") 어댑터. */
    private class SimpleTransform(
        private val idValue: String,
        private val labelValue: String,
        private val paramsValue: List<TransformParam>,
        private val fn: (String, Map<String, String>) -> String
    ) : FlowTransform {
        override fun id(): String = idValue
        override fun label(): String = labelValue
        override fun params(): List<TransformParam> = paramsValue
        override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> {
            val input = inputs.getOrDefault("input", "")
            return mapOf("result" to fn(input, config))
        }
    }

    /** 멀티 입출력 변환. */
    private class MultiTransform(
        private val idValue: String,
        private val labelValue: String,
        private val ins: List<IoSpec>,
        private val outs: List<IoSpec>,
        private val paramsValue: List<TransformParam>,
        private val fn: (Map<String, String>, Map<String, String>) -> Map<String, String>
    ) : FlowTransform {
        override fun id(): String = idValue
        override fun label(): String = labelValue
        override fun inputs(): List<IoSpec> = ins
        override fun outputs(): List<IoSpec> = outs
        override fun params(): List<TransformParam> = paramsValue
        override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> =
            fn(inputs, config)
    }
}
