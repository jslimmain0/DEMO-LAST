package com.flowlink.transform

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.transform.FlowTransform.IoSpec
import com.flowlink.transform.FlowTransform.TransformParam
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.regex.Pattern
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/** 내장 변환 모음(샌드박스 불필요한 순수 함수). 입력은 문자열, 출력은 IoSpec.type 으로 코어션(number/json 등). */
object BuiltinTransforms {

    private val mapper = ObjectMapper()

    fun all(): List<FlowTransform> = listOf(
        // ── 문자열 ─────────────────────────────────────────
        t("split", "구분자로 분리 후 인덱스", "문자열을 구분자로 나눠 N번째 조각을 꺼낸다.", "a,b,c + index 1 → b",
            listOf(TransformParam.of("delimiter", "구분자", ","), TransformParam.number("index", "인덱스(0부터)", "0"))) { input, c ->
            val parts = s(input).split(c.getOrDefault("delimiter", ",")); val i = intOf(c["index"], 0)
            if (i in parts.indices) parts[i] else ""
        },
        t("substring", "부분 문자열", "start~end 바이트 범위를 자른다(end 빈값=끝까지).", "hello + 1~3 → el",
            listOf(TransformParam.number("start", "시작", "0"), TransformParam.number("end", "끝(빈값=끝까지)", ""))) { input, c ->
            val str = s(input); val start = clamp(intOf(c["start"], 0), 0, str.length)
            val end = if (c.getOrDefault("end", "").isBlank()) str.length else clamp(intOf(c["end"], str.length), start, str.length)
            str.substring(start, end)
        },
        t("upper", "대문자", "영문을 대문자로.", "abc → ABC", listOf()) { input, _ -> s(input).uppercase() },
        t("lower", "소문자", "영문을 소문자로.", "ABC → abc", listOf()) { input, _ -> s(input).lowercase() },
        t("trim", "공백 제거", "앞뒤 공백 제거.", "' x ' → x", listOf()) { input, _ -> s(input).trim { it <= ' ' } },
        tNum("length", "길이", "문자열 길이(숫자 출력 — assert 비교 가능).", "hello → 5", listOf()) { input, _ -> s(input).length.toString() },
        t("default", "빈값 대체", "입력이 비면 대체값을, 아니면 원값을.", "'' + fallback=N/A → N/A",
            listOf(TransformParam.of("fallback", "대체값", ""))) { input, c -> s(input).ifBlank { c.getOrDefault("fallback", "") } },
        t("pad-start", "왼쪽 채우기", "지정 길이까지 왼쪽을 채운다(숫자 0채움 등).", "7 + len 4 char 0 → 0007",
            listOf(TransformParam.number("length", "총 길이", "8"), TransformParam.of("char", "채움 문자", "0"))) { input, c ->
            val ch = c.getOrDefault("char", "0").firstOrNull() ?: '0'; s(input).padStart(clamp(intOf(c["length"], 0), 0, 65536), ch)
        },
        t("template", "템플릿 치환", "{{0}}(입력)·{{key}}(config) 를 치환한다.", "'안녕 {{0}}' + input=철수 → 안녕 철수",
            listOf(TransformParam.hint("text", "템플릿", "", "예: 주문 {{0}} 완료"))) { input, c ->
            var out = c.getOrDefault("text", "").replace("{{0}}", s(input))
            for ((k, v) in c) if (k != "text") out = out.replace("{{$k}}", v); out
        },
        t("replace", "정규식 치환", "정규식에 맞는 부분을 치환(실패 시 원문).", "a1b2 + \\d→# → a#b#",
            listOf(TransformParam.of("pattern", "정규식"), TransformParam.of("replacement", "치환값"))) { input, c ->
            try { s(input).replace(c.getOrDefault("pattern", "").toRegex(), c.getOrDefault("replacement", "")) } catch (e: RuntimeException) { s(input) }
        },
        t("regex-extract", "정규식 추출(그룹)", "정규식 그룹 N을 뽑는다.", "id=42 + (\\d+) → 42",
            listOf(TransformParam.of("pattern", "정규식"), TransformParam.number("group", "그룹 번호", "1"))) { input, c ->
            try {
                val m = Pattern.compile(c.getOrDefault("pattern", "")).matcher(s(input))
                if (m.find()) { val g = intOf(c["group"], 1); if (g <= m.groupCount()) n(m.group(g)) else "" } else ""
            } catch (e: RuntimeException) { "" }
        },

        // ── 숫자/산술 ───────────────────────────────────────
        tNum("arithmetic", "산술 계산", "입력(a) 과 b 를 연산(숫자 출력).", "1000 op * b 1.1 → 1100",
            listOf(TransformParam.select("op", "연산", listOf("+", "-", "*", "/", "%"), "+"), TransformParam.number("b", "b", "0"))) { input, c ->
            val a = dblOf(input, 0.0); val b = dblOf(c["b"], 0.0)
            val r = when (c.getOrDefault("op", "+")) { "-" -> a - b; "*" -> a * b; "/" -> if (b == 0.0) 0.0 else a / b; "%" -> if (b == 0.0) 0.0 else a % b; else -> a + b }
            fmtNum(r)
        },
        tNum("round", "반올림/올림/내림", "소수 자릿수로 round/floor/ceil(숫자 출력).", "3.14159 + digits 2 → 3.14",
            listOf(TransformParam.select("mode", "방식", listOf("round", "floor", "ceil"), "round"), TransformParam.number("digits", "자릿수", "0"))) { input, c ->
            val v = dblOf(input, 0.0); val d = clamp(intOf(c["digits"], 0), 0, 15); val f = Math.pow(10.0, d.toDouble())
            val r = when (c.getOrDefault("mode", "round")) { "floor" -> Math.floor(v * f) / f; "ceil" -> Math.ceil(v * f) / f; else -> Math.round(v * f) / f }
            fmtNum(r)
        },
        t("number-format", "숫자 포맷(천단위)", "천단위 콤마 + 소수 자릿수(문자열).", "1234567 + digits 0 → 1,234,567",
            listOf(TransformParam.number("digits", "소수 자릿수", "0"))) { input, c ->
            val v = dblOf(input, 0.0); String.format("%,.${clamp(intOf(c["digits"], 0), 0, 100)}f", v)
        },

        // ── JSON ────────────────────────────────────────────
        t("json-extract", "JSON 필드 추출", "점 경로로 값을 뽑는다(a.b.0.c).", "{\"u\":{\"id\":7}} + u.id → 7",
            listOf(TransformParam.hint("path", "경로", "", "예: data.items.0.name"))) { input, c ->
            try {
                var node = mapper.readTree(s(input))
                for (seg in c.getOrDefault("path", "").split(".").filter { it.isNotBlank() }) {
                    node = if (node.isArray) node.path(seg.toIntOrNull() ?: -1) else node.path(seg)
                }
                if (node.isMissingNode || node.isNull) "" else if (node.isValueNode) node.asText() else node.toString()
            } catch (e: Exception) { "" }
        },
        jsonT("json-parse", "JSON 파싱", "문자열을 JSON 값(객체/배열)으로 — 하위에서 재추출 가능.", "'{\"a\":1}' → 객체") { input, _ ->
            try { mapper.readTree(s(input)); s(input) } catch (e: Exception) { "" } // 이미 JSON 텍스트 — 코어션이 네이티브화
        },

        // ── 인코딩/해시 ──────────────────────────────────────
        t("base64-encode", "Base64 인코딩", "UTF-8 → Base64.", "hi → aGk=", listOf()) { input, _ -> Base64.getEncoder().encodeToString(s(input).toByteArray(StandardCharsets.UTF_8)) },
        t("base64-decode", "Base64 디코딩", "Base64 → UTF-8.", "aGk= → hi", listOf()) { input, _ -> try { String(Base64.getDecoder().decode(s(input)), StandardCharsets.UTF_8) } catch (e: IllegalArgumentException) { "" } },
        t("hex-encode", "Hex 인코딩", "UTF-8 바이트를 16진수로.", "AB → 4142", listOf()) { input, _ -> s(input).toByteArray(StandardCharsets.UTF_8).joinToString("") { "%02x".format(it) } },
        t("url-encode", "URL 인코딩", "퍼센트 인코딩.", "a b → a+b", listOf()) { input, _ -> URLEncoder.encode(s(input), StandardCharsets.UTF_8) },
        t("url-decode", "URL 디코딩", "퍼센트 디코딩.", "a%20b → a b", listOf()) { input, _ -> URLDecoder.decode(s(input), StandardCharsets.UTF_8) },
        t("sha256", "SHA-256(hex)", "SHA-256 해시(hex).", "", listOf()) { input, _ -> hash("SHA-256", s(input)) },
        t("md5", "MD5(hex)", "MD5 해시(hex).", "", listOf()) { input, _ -> hash("MD5", s(input)) },
        t("hmac-sha256", "HMAC-SHA256(hex)", "키로 HMAC-SHA256 서명(hex).", "메시지+key → 서명",
            listOf(TransformParam.of("key", "비밀키"))) { input, c -> hmac(c.getOrDefault("key", ""), s(input)) },

        // ── 암호화(가역) ── 키/IV 는 입력 포트라 시크릿 볼트({{이름@secret}})를 바인딩할 수 있다.
        MultiTransform("aes-encrypt", "AES 암호화", "평문을 AES로 암호화 → base64/hex. 키·IV 는 입력 포트(시크릿 바인딩 권장).",
            listOf(IoSpec("input", "평문", "string"), IoSpec("key", "키", "string"), IoSpec("iv", "IV(ECB 외 필수)", "string")),
            listOf(IoSpec.of("result", "암호문")),
            listOf(
                TransformParam.select("mode", "모드", listOf("CBC", "GCM", "ECB"), "CBC"),
                TransformParam.select("keyFormat", "키 형식", listOf("utf8", "base64", "hex"), "utf8"),
                TransformParam.select("ivFormat", "IV 형식", listOf("utf8", "base64", "hex"), "utf8"),
                TransformParam.select("output", "암호문 인코딩", listOf("base64", "hex"), "base64"),
            )) { inp, c -> mapOf("result" to aes(true, inp, c)) },
        MultiTransform("aes-decrypt", "AES 복호화", "AES 암호문(base64/hex)을 평문으로. 키·IV·모드·인코딩을 암호화와 동일하게.",
            listOf(IoSpec("input", "암호문", "string"), IoSpec("key", "키", "string"), IoSpec("iv", "IV(ECB 외 필수)", "string")),
            listOf(IoSpec.of("result", "평문")),
            listOf(
                TransformParam.select("mode", "모드", listOf("CBC", "GCM", "ECB"), "CBC"),
                TransformParam.select("keyFormat", "키 형식", listOf("utf8", "base64", "hex"), "utf8"),
                TransformParam.select("ivFormat", "IV 형식", listOf("utf8", "base64", "hex"), "utf8"),
                TransformParam.select("output", "암호문 인코딩", listOf("base64", "hex"), "base64"),
            )) { inp, c -> mapOf("result" to aes(false, inp, c)) },

        // ── 날짜/시각 ────────────────────────────────────────
        t("now", "현재 시각", "현재 시각을 지정 포맷으로.", "pattern yyyyMMdd → 20260718",
            listOf(TransformParam.of("pattern", "포맷", "yyyy-MM-dd'T'HH:mm:ss"), TransformParam.of("zone", "타임존", "Asia/Seoul"))) { _, c ->
            try { DateTimeFormatter.ofPattern(c.getOrDefault("pattern", "yyyy-MM-dd'T'HH:mm:ss")).withZone(ZoneId.of(c.getOrDefault("zone", "Asia/Seoul").ifBlank { "Asia/Seoul" })).format(Instant.now()) } catch (e: Exception) { Instant.now().toString() }
        },
        tNum("epoch-now", "현재 epoch(초)", "현재 유닉스 시각(초, 숫자).", "→ 1784...", listOf()) { _, _ -> Instant.now().epochSecond.toString() },

        // ── 멀티 입출력 ──────────────────────────────────────
        MultiTransform("concat", "두 값 이어붙이기", "값1 + 값2 를 연결.",
            listOf(IoSpec.of("a", "값1"), IoSpec.of("b", "값2")), listOf(IoSpec.of("result", "결과")), listOf()) { inp, _ -> mapOf("result" to (s(inp["a"]) + s(inp["b"]))) },
        MultiTransform("pair-split", "구분자로 둘로 분리", "입력을 구분자로 앞/뒤 두 값으로.",
            listOf(IoSpec.of("value", "입력")), listOf(IoSpec.of("first", "앞"), IoSpec.of("second", "뒤")),
            listOf(TransformParam.of("delimiter", "구분자", "="))) { inp, c ->
            val p = s(inp["value"]).split(c.getOrDefault("delimiter", "="), limit = 2); mapOf("first" to p.getOrElse(0) { "" }, "second" to p.getOrElse(1) { "" })
        }
    )

    // --- 헬퍼 ---

    private fun t(id: String, label: String, desc: String, example: String, params: List<TransformParam>, fn: (String, Map<String, String>) -> String): FlowTransform =
        SimpleTransform(id, label, desc, "string", example, params, fn)

    private fun tNum(id: String, label: String, desc: String, example: String, params: List<TransformParam>, fn: (String, Map<String, String>) -> String): FlowTransform =
        SimpleTransform(id, label, desc, "number", example, params, fn)

    private fun jsonT(id: String, label: String, desc: String, example: String, fn: (String, Map<String, String>) -> String): FlowTransform =
        SimpleTransform(id, label, desc, "json", example, listOf(), fn)

    private fun s(v: String?): String = v ?: ""
    private fun n(v: String?): String = v ?: ""
    private fun intOf(v: String?, def: Int): Int = v?.trim()?.toIntOrNull() ?: def
    private fun dblOf(v: String?, def: Double): Double = v?.trim()?.toDoubleOrNull() ?: def
    private fun clamp(v: Int, lo: Int, hi: Int): Int = maxOf(lo, minOf(v, hi))
    /** 정수면 소수점 없이 — assert/표시가 깔끔하게. */
    private fun fmtNum(d: Double): String = if (d == Math.floor(d) && !d.isInfinite()) d.toLong().toString() else d.toString()

    private fun hash(algo: String, input: String): String = try {
        MessageDigest.getInstance(algo).digest(input.toByteArray(StandardCharsets.UTF_8)).joinToString("") { "%02x".format(it) }
    } catch (e: Exception) { "" }

    private fun hmac(key: String, input: String): String = try {
        val mac = Mac.getInstance("HmacSHA256"); mac.init(SecretKeySpec(key.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
        mac.doFinal(input.toByteArray(StandardCharsets.UTF_8)).joinToString("") { "%02x".format(it) }
    } catch (e: Exception) { "" }

    /**
     * AES 암/복호화. 키/IV 는 입력(포트), mode·형식·인코딩은 config. 실패(키 길이·IV·패딩 오류 등)는 예외를 던져
     * transformNode 가 "변환 실패: …" 로 표면화(암호화는 조용한 빈값보다 명확한 실패가 유용).
     */
    private fun aes(encrypt: Boolean, inp: Map<String, String>, c: Map<String, String>): String {
        val keyBytes = decodeBytes(s(inp["key"]), c.getOrDefault("keyFormat", "utf8"))
        require(keyBytes.size == 16 || keyBytes.size == 24 || keyBytes.size == 32) { "AES 키는 16/24/32바이트여야 합니다(현재 ${keyBytes.size}). keyFormat 을 확인하세요." }
        val mode = c.getOrDefault("mode", "CBC").uppercase()
        val transformation = when (mode) { "GCM" -> "AES/GCM/NoPadding"; "ECB" -> "AES/ECB/PKCS5Padding"; else -> "AES/CBC/PKCS5Padding" }
        val cipher = Cipher.getInstance(transformation)
        val op = if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE
        val keySpec = SecretKeySpec(keyBytes, "AES")
        if (mode == "ECB") {
            cipher.init(op, keySpec)
        } else {
            val iv = decodeBytes(s(inp["iv"]), c.getOrDefault("ivFormat", "utf8"))
            if (mode == "GCM") cipher.init(op, keySpec, GCMParameterSpec(128, iv)) else cipher.init(op, keySpec, IvParameterSpec(iv))
        }
        val enc = c.getOrDefault("output", "base64")
        return if (encrypt) {
            encodeBytes(cipher.doFinal(s(inp["input"]).toByteArray(StandardCharsets.UTF_8)), enc)
        } else {
            String(cipher.doFinal(decodeBytes(s(inp["input"]), enc)), StandardCharsets.UTF_8)
        }
    }

    private fun decodeBytes(v: String, fmt: String): ByteArray = when (fmt.lowercase()) {
        "base64" -> Base64.getDecoder().decode(v.trim())
        "hex" -> hexToBytes(v)
        else -> v.toByteArray(StandardCharsets.UTF_8)
    }

    private fun encodeBytes(b: ByteArray, fmt: String): String =
        if (fmt.equals("hex", true)) b.joinToString("") { "%02x".format(it) } else Base64.getEncoder().encodeToString(b)

    private fun hexToBytes(s: String): ByteArray {
        val t = s.trim().replace(" ", "")
        require(t.length % 2 == 0) { "hex 길이가 홀수입니다." }
        return ByteArray(t.length / 2) { t.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    /** 단일 입력("input") → 단일 출력("result") 어댑터. outType 이 number/json 이면 실행 엔진이 코어션. */
    private class SimpleTransform(
        private val idValue: String,
        private val labelValue: String,
        private val descValue: String,
        private val outType: String,
        private val exampleValue: String,
        private val paramsValue: List<TransformParam>,
        private val fn: (String, Map<String, String>) -> String,
    ) : FlowTransform {
        override fun id(): String = idValue
        override fun label(): String = labelValue
        override fun description(): String = descValue
        override fun outputs(): List<IoSpec> = listOf(IoSpec("result", "결과", outType, exampleValue))
        override fun params(): List<TransformParam> = paramsValue
        override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> =
            mapOf("result" to fn(inputs.getOrDefault("input", ""), config))
    }

    /** 멀티 입출력 변환. */
    private class MultiTransform(
        private val idValue: String,
        private val labelValue: String,
        private val descValue: String,
        private val ins: List<IoSpec>,
        private val outs: List<IoSpec>,
        private val paramsValue: List<TransformParam>,
        private val fn: (Map<String, String>, Map<String, String>) -> Map<String, String>,
    ) : FlowTransform {
        override fun id(): String = idValue
        override fun label(): String = labelValue
        override fun description(): String = descValue
        override fun inputs(): List<IoSpec> = ins
        override fun outputs(): List<IoSpec> = outs
        override fun params(): List<TransformParam> = paramsValue
        override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> = fn(inputs, config)
    }
}
