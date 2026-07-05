package com.flowlink.mock

import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import java.util.LinkedHashMap
import java.util.Locale

/** mock 서빙 공용 타입/유틸 — 게이트웨이가 파싱한 요청과 렌더된 응답. */
object MockHttp {

    /**
     * 게이트웨이가 파싱한 요청. path 는 slug 제거 후(항상 / 시작), header 키는 소문자,
     * bodyFields 는 JSON 최상위 키(값은 문자열화) 또는 urlencoded 필드.
     */
    data class MockRequest(
        val method: String,
        val path: String,
        val query: Map<String, String>,
        val headers: Map<String, String>,
        val bodyText: String,
        val bodyFields: Map<String, String>
    )

    /** 서빙할 응답(바이트 확정) + 선택적 지연·콜백 발사 명세. */
    data class MockResponse(
        val status: Int,
        val contentType: String, // 완성된 Content-Type 헤더 값
        val headers: Map<String, String>,
        val body: ByteArray,
        val delayMs: Int,
        val callback: FiredCallback?
    ) {
        companion object {
            @JvmStatic
            fun of(status: Int, contentType: String, body: ByteArray): MockResponse =
                MockResponse(status, contentType, emptyMap(), body, 0, null)
        }
    }

    /** 템플릿 해석이 끝난 콜백 발사 명세. */
    data class FiredCallback(
        val afterMs: Int,
        val url: String,
        val method: String,
        val contentType: String,
        val body: String?,
        val retryUntilOk: Boolean
    )

    // ---------- charset ----------

    @JvmStatic
    fun charsetOf(name: String?): Charset {
        if (name == null || name.isBlank()) {
            return StandardCharsets.UTF_8
        }
        return try {
            Charset.forName(name)
        } catch (e: Exception) {
            StandardCharsets.UTF_8
        }
    }

    /** Content-Type 에 쓸 IANA 이름(HttpNodeExecutor.wireCharset 과 동일 보정 — MS949 → windows-949). */
    @JvmStatic
    fun wireCharset(cs: Charset): String {
        val n = cs.name()
        return if (n.equals("x-windows-949", ignoreCase = true)) "windows-949" else n
    }

    /** 축약(json/text/html/xml) 또는 mime → 완성된 Content-Type 헤더 값. */
    @JvmStatic
    fun contentTypeHeader(shorthand: String?, cs: Charset): String {
        val t = if (shorthand == null || shorthand.isBlank()) "json" else shorthand.lowercase(Locale.ROOT)
        val mime = when (t) {
            "json" -> "application/json"
            "text" -> "text/plain"
            "html" -> "text/html"
            "xml" -> "application/xml"
            "urlencoded", "form" -> "application/x-www-form-urlencoded"
            else -> if (t.contains("/")) t else "text/plain"
        }
        return if (mime.contains("charset")) mime else "$mime; charset=" + wireCharset(cs)
    }

    // ---------- urlencoded ----------

    /** a=1&b=2 → 맵(첫 값 우선). 퍼센트 디코딩은 cs 문자셋. */
    @JvmStatic
    fun parseUrlEncoded(text: String?, cs: Charset): MutableMap<String, String> {
        val out = LinkedHashMap<String, String>()
        if (text == null || text.isBlank()) {
            return out
        }
        for (pair in text.split("&")) {
            if (pair.isEmpty()) {
                continue
            }
            val eq = pair.indexOf('=')
            val k = urlDecode(if (eq >= 0) pair.substring(0, eq) else pair, cs)
            val v = if (eq >= 0) urlDecode(pair.substring(eq + 1), cs) else ""
            out.putIfAbsent(k, v)
        }
        return out
    }

    @JvmStatic
    fun urlDecode(s: String, cs: Charset): String =
        try {
            java.net.URLDecoder.decode(s, cs)
        } catch (e: Exception) {
            s
        }

    @JvmStatic
    fun urlEncode(s: String?, cs: Charset): String =
        try {
            java.net.URLEncoder.encode(s ?: "", cs)
        } catch (e: Exception) {
            s ?: ""
        }

    /** 키-값들을 urlencoded 본문으로(UTF-8). */
    @JvmStatic
    fun toUrlEncoded(pairs: List<Map.Entry<String, String>>): String {
        val sb = StringBuilder()
        for (e in pairs) {
            if (sb.isNotEmpty()) {
                sb.append('&')
            }
            sb.append(urlEncode(e.key, StandardCharsets.UTF_8))
                .append('=')
                .append(urlEncode(e.value, StandardCharsets.UTF_8))
        }
        return sb.toString()
    }

    // ---------- URL 경로/헤더 디코딩 (게이트웨이 공용) ----------

    /**
     * Content-Type 헤더의 `charset=` 를 Charset 으로. 없으면 UTF-8.
     * 레거시 별칭 보정(`windows-949`→JVM 정규명 `x-windows-949`)은 [wireCharset]의 역방향.
     */
    @JvmStatic
    fun charsetFromContentType(contentType: String?): Charset {
        if (contentType == null) {
            return StandardCharsets.UTF_8
        }
        val i = contentType.lowercase(Locale.ROOT).indexOf("charset=")
        if (i < 0) {
            return StandardCharsets.UTF_8
        }
        var name = contentType.substring(i + "charset=".length).trim()
        val semi = name.indexOf(';')
        if (semi >= 0) {
            name = name.substring(0, semi)
        }
        name = name.replace("\"", "").trim()
        if (name.equals("windows-949", ignoreCase = true)) {
            name = "x-windows-949"
        }
        return charsetOf(name)
    }

    /**
     * URL 경로를 세그먼트별로 percent-디코딩한다. URLDecoder 와 달리 `'+'`는 리터럴로 둔다
     * (URL 경로에서 `'+'`는 리터럴, 공백은 `%20` — form 디코더를 경로에 쓰면 경로 파라미터가 오염된다).
     * 인코딩된 슬래시(`%2F`)는 세그먼트 내부 값으로 보존.
     */
    @JvmStatic
    fun decodePath(rawPath: String?): String {
        if (rawPath == null || rawPath.isEmpty()) {
            return "/"
        }
        val segs = rawPath.split("/")
        val sb = StringBuilder()
        for (i in segs.indices) {
            if (i > 0) {
                sb.append('/')
            }
            sb.append(percentDecodeKeepPlus(segs[i]))
        }
        return sb.toString()
    }

    /** %XX 를 UTF-8 바이트로 디코딩하되 `'+'`와 그 외 문자는 그대로 둔다(URLDecoder 와 달리 `'+'`≠공백). */
    private fun percentDecodeKeepPlus(s: String): String {
        if (s.indexOf('%') < 0) {
            return s
        }
        val buf = java.io.ByteArrayOutputStream(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%' && i + 2 < s.length) {
                val hi = Character.digit(s[i + 1], 16)
                val lo = Character.digit(s[i + 2], 16)
                if (hi >= 0 && lo >= 0) {
                    buf.write((hi shl 4) + lo)
                    i += 3
                    continue
                }
            }
            val cb = c.toString().toByteArray(StandardCharsets.UTF_8)
            buf.write(cb, 0, cb.size)
            i++
        }
        return String(buf.toByteArray(), StandardCharsets.UTF_8)
    }
}
