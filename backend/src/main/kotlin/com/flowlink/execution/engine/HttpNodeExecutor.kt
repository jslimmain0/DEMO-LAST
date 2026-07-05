package com.flowlink.execution.engine

import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import com.flowlink.core.graph.NodeField
import com.flowlink.execution.config.ExecutionProperties
import com.flowlink.execution.config.HttpClientConfig
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpMethod
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import org.w3c.dom.Document
import org.w3c.dom.Element
import org.xml.sax.InputSource
import java.io.IOException
import java.io.InputStream
import java.io.StringReader
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import java.util.Arrays
import java.util.regex.Pattern
import javax.xml.parsers.DocumentBuilderFactory

/**
 * HTTP 요청 노드를 <b>서버사이드</b>로 실행한다. (프로토타입은 브라우저 fetch → CORS 한계,
 * 시크릿 노출. 서버 실행으로 그 한계를 제거하되 SSRF 가드를 강제.)
 */
@Component
class HttpNodeExecutor(
    @Qualifier(HttpClientConfig.NODE_REST_CLIENT) private val restClient: RestClient,
    private val tokens: TokenResolver,
    private val ssrfGuard: SsrfGuard,
    private val json: JsonService,
    props: ExecutionProperties
) {

    private val maxResponseBytes: Long = props.http.maxResponseBytes

    /**
     * 한 노드의 HTTP 요청을 <b>조립만</b> 한다(전송하지 않음). server/client 모드 공통.
     * client 모드는 이 결과를 브라우저로 넘겨 직접 호출하게 하고, server 모드는 그대로 전송한다.
     */
    fun build(node: GraphNode, ctx: ExecutionContext): BuiltRequest {
        val fields = node.fieldsOrEmpty()

        // 1) 요청값 수집(req: 스코프로 다운스트림에 노출)
        val reqValues = LinkedHashMap<String, Any?>()
        for (tab in listOf("params", "headers", "body")) {
            for (f in fieldsOf(node, tab)) {
                if (notBlank(f.key)) {
                    reqValues[f.key!!] = tokens.fieldValue(f, ctx)
                }
            }
        }

        // 2) URL
        val base = if (node.baseUrlBound != null)
            tokens.stringify(tokens.resolveBinding(node.baseUrlBound, ctx))
        else
            tokens.resolveTokens(node.baseUrl ?: "", ctx)
        var url = base + tokens.resolveTokens(node.path ?: "", ctx)

        val method = if (node.method == null) "GET" else node.method.uppercase()
        val cs = charsetOf(node.charset) // 요청 인코딩·응답 디코딩 문자셋(기본 UTF-8)

        // 3) 헤더 — 필드 또는 Raw(Key: Value 줄바꿈)
        val headers = LinkedHashMap<String, String>()
        val skipped = StringBuilder()
        if (node.headersRaw == true) {
            val rawH = node.rawHeaders ?: ""
            for (line in rawH.split(Regex("\\r?\\n"))) {
                val l = line.trim()
                if (l.isEmpty()) {
                    continue
                }
                val i = l.indexOf(':')
                if (i < 0) {
                    continue
                }
                val k = l.substring(0, i).trim()
                if (k.isEmpty()) {
                    continue
                }
                if (!HEADER_NAME.matcher(k).matches()) {
                    skipped.append(if (skipped.isEmpty()) "" else ", ").append(k)
                    continue
                }
                val v = tokens.resolveTokens(l.substring(i + 1).trim(), ctx)
                headers[k] = v.replace(Regex("[\\r\\n]+"), " ")
            }
        } else {
            for (f in fields.headersOrEmpty()) {
                val k = if (f.key == null) "" else f.key.trim()
                if (k.isEmpty()) {
                    continue
                }
                if (!HEADER_NAME.matcher(k).matches()) {
                    skipped.append(if (skipped.isEmpty()) "" else ", ").append(k)
                    continue
                }
                headers[k] = tokens.stringify(tokens.fieldValue(f, ctx)).replace(Regex("[\\r\\n]+"), " ")
            }
        }

        // 4) 쿼리 파라미터 — 필드 또는 Raw(a=1&b=2 원문)
        val qsStr: String
        if (node.paramsRaw == true) {
            // Raw 모드: 토큰만 치환하고 원문 그대로 사용(인코딩은 사용자 책임 — 바디 urlencoded raw 와 동일 규약)
            qsStr = tokens.resolveTokens(node.rawParams ?: "", ctx).trim()
        } else {
            val qs = StringBuilder()
            for (f in fields.paramsOrEmpty()) {
                if (notBlank(f.key)) {
                    if (qs.isNotEmpty()) {
                        qs.append('&')
                    }
                    qs.append(enc(f.key, cs)).append('=').append(enc(tokens.stringify(tokens.fieldValue(f, ctx)), cs))
                }
            }
            qsStr = qs.toString()
        }
        if (qsStr.isNotEmpty()) {
            url += (if (url.indexOf('?') >= 0) "&" else "?") + qsStr
        }

        // 5) 바디(GET/HEAD 제외)
        var bodyString: String? = null
        var bodyDesc = ""
        if (method != "GET" && method != "HEAD") {
            val bt = node.bodyType ?: "json"
            when (bt) {
                "json" -> {
                    if (node.jsonRaw == true) {
                        bodyString = tokens.resolveTokens(node.rawBody ?: "", ctx)
                    } else {
                        val obj = LinkedHashMap<String, Any?>()
                        for (f in fields.bodyOrEmpty()) {
                            if (notBlank(f.key)) {
                                // 필드 타입에 따라 따옴표 여부 결정: number/boolean/json 은 코어션, string/미지정은 기존 동작
                                obj[f.key!!] = coerceJson(tokens.fieldValue(f, ctx), f.type)
                            }
                        }
                        bodyString = json.toJson(obj)
                    }
                    headers.putIfAbsent("Content-Type", "application/json")
                }
                "urlencoded", "form" -> {
                    if (node.jsonRaw == true) {
                        // Raw 모드: 본문을 직접 입력(a=1&b=2). 토큰만 치환하고 그대로 전송.
                        bodyString = tokens.resolveTokens(node.rawBody ?: "", ctx)
                    } else {
                        val b = StringBuilder()
                        for (f in fields.bodyOrEmpty()) {
                            if (notBlank(f.key)) {
                                if (b.isNotEmpty()) {
                                    b.append('&')
                                }
                                b.append(enc(f.key, cs)).append('=').append(enc(tokens.stringify(tokens.fieldValue(f, ctx)), cs))
                            }
                        }
                        bodyString = b.toString()
                    }
                    // NOTE: multipart(form-data)는 후속 Phase. 현재는 urlencoded 로 처리.
                    headers.putIfAbsent("Content-Type", "application/x-www-form-urlencoded")
                }
                "raw", "xml" -> {
                    bodyString = tokens.resolveTokens(node.rawBody ?: "", ctx)
                    if (bt == "xml") {
                        headers.putIfAbsent("Content-Type", "application/xml")
                    }
                }
                else -> bodyString = tokens.resolveTokens(node.rawBody ?: "", ctx)
            }
            bodyDesc = bodyString ?: ""
        }

        // 비UTF-8 문자셋이면 본문 Content-Type 에 charset 을 명시(서버가 올바르게 해석하도록).
        // 단 client 모드는 브라우저 fetch 가 본문을 UTF-8 로 보내므로(헤더 charset 무시) 잘못된 주장 방지 위해 미부착.
        val clientMode = "client".equals(node.reqMode, ignoreCase = true)
        if (bodyString != null && cs != StandardCharsets.UTF_8 && !clientMode) {
            val ct = headers["Content-Type"]
            if (ct != null && !ct.lowercase().contains("charset")) {
                headers["Content-Type"] = ct + "; charset=" + wireCharset(cs)
            }
        }

        val reqStr = buildRequestText(method, url, headers, bodyDesc, skipped.toString())
        return BuiltRequest(method, url, headers, bodyString, reqStr, reqValues)
    }

    /** server 모드: 서버가 직접 호출한다(SSRF 가드 강제). */
    fun execute(node: GraphNode, ctx: ExecutionContext): NodeResult {
        val req = build(node, ctx)

        val uri: URI = try {
            URI.create(req.url)
        } catch (e: IllegalArgumentException) {
            return NodeResult.fail(0, req.requestText, "⚠ 잘못된 URL: " + e.message)
        }
        try {
            ssrfGuard.check(uri)
        } catch (e: SsrfBlockedException) {
            return NodeResult.fail(0, req.requestText, "⚠ 차단됨(SSRF 가드): " + e.message)
        }

        return try {
            val cs = charsetOf(node.charset)
            val finalHeaders = req.headers
            val spec = restClient.method(HttpMethod.valueOf(req.method)).uri(uri)
                .headers { h -> finalHeaders.forEach { (k, v) -> h.set(k, v) } }
            // 본문은 선택 문자셋으로 인코딩한 바이트로 전송(UTF-8이면 기존과 동일). 응답도 같은 문자셋으로 디코딩.
            val raw = (if (req.body != null) spec.body(req.body.toByteArray(cs)) else spec)
                .exchange { _, response -> readRaw(response, cs) }

            val value = parseResponse(node.respType, raw, cs)
            NodeResult.okHttp(raw.status, req.requestText, raw.text, value, req.reqValues)
        } catch (e: Exception) {
            NodeResult.fail(0, req.requestText, "⚠ 요청 실패: " + (e.message ?: e.toString()))
        }
    }

    /**
     * client 모드: 브라우저가 대신 호출하고 돌려준 결과({@code status}/{@code body})를 NodeResult 로 변환한다.
     * 서버는 전송하지 않으므로 SSRF 가드 대상이 아니다(브라우저의 동일출처/CORS 정책이 적용됨).
     */
    fun clientResult(node: GraphNode, req: BuiltRequest, status: Int, body: String?, error: String?): NodeResult {
        if (error != null && !error.isBlank()) {
            return NodeResult.fail(if (status > 0) status else 0, req.requestText, "⚠ 클라이언트 요청 실패: $error")
        }
        val text = body ?: ""
        // client 모드는 브라우저가 이미 디코딩한 문자열을 받으므로 form 퍼센트 디코딩은 UTF-8 기준
        val value = parseResponse(node.respType,
            RawResponse(status, text, text.toByteArray(StandardCharsets.UTF_8).size), StandardCharsets.UTF_8)
        return NodeResult.okHttp(status, req.requestText, text, value, req.reqValues)
    }

    private fun readRaw(response: RestClient.RequestHeadersSpec.ConvertibleClientHttpResponse, cs: Charset): RawResponse {
        val status = response.statusCode.value()
        response.body.use { input ->
            val cap = Math.min(maxResponseBytes + 1, Integer.MAX_VALUE.toLong()).toInt()
            var bytes = input.readNBytes(cap)
            val truncated = bytes.size > maxResponseBytes
            if (truncated) {
                bytes = Arrays.copyOf(bytes, maxResponseBytes.toInt())
            }
            return RawResponse(status, String(bytes, cs), bytes.size)
        }
    }

    /**
     * 응답 본문을 노드의 respType 에 맞는 "키-값 맵"으로 해석한다. 하위 노드는 이 맵의 키로 바인딩한다.
     * <ul>
     *   <li><b>json</b>: JSON 파싱(객체/배열)</li>
     *   <li><b>form</b>: {@code a=1&b=2} urlencoded → 키-값(중복 키는 리스트)</li>
     *   <li><b>query</b>: 본문이 URL({@code …?a=1&b=2}) 또는 쿼리스트링일 때 {@code ?} 뒤 파라미터 → 키-값</li>
     *   <li><b>xml</b>: 루트의 최상위 자식 엘리먼트명 → 텍스트(중복은 리스트). 평면 XML(코드/메시지 등)에 적합</li>
     *   <li><b>text/binary</b>: 키가 없으므로 본문 전체를 {@code body} 한 키로 제공</li>
     * </ul>
     * 어떤 타입이든 파싱 실패 시 본문을 {@code body} 로 보존한다(데이터 유실 방지).
     */
    private fun parseResponse(respType: String?, raw: RawResponse, cs: Charset): Any {
        val rt = respType ?: "json"
        return when (rt) {
            "json" -> {
                try {
                    val v = json.mapper().readValue(raw.text, Any::class.java)
                    if (v is Map<*, *> || v is List<*>) {
                        v // 객체/배열은 그대로(키 바인딩·배열 첫 원소 규약 유지)
                    } else {
                        // 스칼라(숫자/문자열/불리언/null)는 map.get(key) 로 풀리지 않으므로 body 로 감싼다.
                        // 파싱된 값을 담아 문자열은 따옴표 없이 제공(null 만 원문 "null" 보존).
                        mapOf<String, Any?>("body" to (v ?: raw.text))
                    }
                } catch (e: Exception) {
                    mapOf<String, Any?>("body" to raw.text)
                }
            }
            "form", "urlencoded" -> parseForm(raw.text, cs)
            "query" -> parseQuery(raw.text, cs)
            "xml" -> parseXml(raw.text)
            "binary" -> mapOf<String, Any?>("body" to "(binary · " + raw.byteLength + " bytes)")
            else -> mapOf<String, Any?>("body" to raw.text) // text — 본문 전체를 body 로
        }
    }

    /**
     * 쿼리 파라미터 응답 — 리다이렉트 URL 이나 next-url 처럼 응답 본문이 URL({@code https://x/cb?a=1&b=2})
     * 또는 쿼리스트링({@code ?a=1&b=2} / {@code a=1&b=2})일 때, 파라미터를 키-값 맵으로 해석한다.
     * 쿼리로 볼 수 없는 본문(파라미터 없음)은 body 로 보존한다.
     */
    private fun parseQuery(body: String?, cs: Charset): Map<String, Any?> {
        val qs = extractQueryString(body) ?: return mapOf("body" to (body ?: ""))
        val parsed = parseForm(qs, cs)
        return if (parsed.isEmpty()) mapOf("body" to (body ?: "")) else parsed
    }

    /** application/x-www-form-urlencoded 응답을 키-값 맵으로 파싱(중복 키는 리스트로 누적). 퍼센트 디코딩은 cs 문자셋. */
    private fun parseForm(body: String?, cs: Charset): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        if (body == null || body.isBlank()) {
            return out
        }
        for (pair in body.split("&")) {
            if (pair.isEmpty()) {
                continue
            }
            val eq = pair.indexOf('=')
            val k = dec(if (eq >= 0) pair.substring(0, eq) else pair, cs)
            val v = dec(if (eq >= 0) pair.substring(eq + 1) else "", cs)
            if (k.isNotEmpty()) {
                putMulti(out, k, v)
            }
        }
        return out
    }

    /**
     * XML 응답을 키-값 맵으로 파싱. 루트의 자식 요소들을 키로 삼되, 자식 요소를 더 가진 요소는 중첩 맵으로
     * 재귀 변환하고(중복은 리스트), 잎 요소는 텍스트를 trim 해서 담는다(프리티프린트 공백 누수 방지).
     * 스칼라 루트(예: {@code <amount>100</amount>})는 루트 요소명으로 키잉해 선언 출력이 바로 풀리게 한다.
     * 실패 시 본문을 body 로 보존한다.
     */
    private fun parseXml(body: String?): Any {
        if (body == null || body.isBlank()) {
            return mapOf<String, Any?>("body" to (body ?: ""))
        }
        return try {
            val dbf = DocumentBuilderFactory.newInstance()
            // 외부 엔티티/DOCTYPE 차단(파싱 안정성)
            dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
            dbf.isExpandEntityReferences = false
            val db = dbf.newDocumentBuilder()
            val doc: Document = db.parse(InputSource(StringReader(body)))
            val root: Element = doc.documentElement
                ?: return mapOf<String, Any?>("body" to body)
            val value = xmlValue(root)
            if (value is Map<*, *>) {
                value // 루트에 자식 요소가 있으면 {자식명: …}
            } else {
                val out = LinkedHashMap<String, Any?>() // 스칼라 루트는 루트 요소명으로 키잉
                out[root.nodeName] = value
                out
            }
        } catch (e: Exception) {
            mapOf<String, Any?>("body" to body) // 파싱 실패 → 통째 보존
        }
    }

    /** XML 요소 → 값. 자식 요소가 있으면 맵(중복은 리스트), 없으면 잎 텍스트(trim). */
    private fun xmlValue(el: Element): Any {
        val childEls = ArrayList<Element>()
        val ch = el.childNodes
        for (i in 0 until ch.length) {
            val n = ch.item(i)
            if (n.nodeType == org.w3c.dom.Node.ELEMENT_NODE) {
                childEls.add(n as Element)
            }
        }
        if (childEls.isEmpty()) {
            return el.textContent.trim()
        }
        val m = LinkedHashMap<String, Any?>()
        for (c in childEls) {
            putMulti(m, c.nodeName, xmlValue(c))
        }
        return m
    }

    private fun buildRequestText(method: String, url: String, headers: Map<String, String>,
                                 bodyDesc: String?, skipped: String): String {
        val sb = StringBuilder()
        if (skipped.isNotEmpty()) {
            sb.append("⚠ 잘못된 헤더 이름이라 무시됨: ").append(skipped).append('\n')
        }
        sb.append(method).append(' ').append(url).append('\n')
        if (headers.isNotEmpty()) {
            sb.append("headers: ").append(json.toJson(headers)).append('\n')
        }
        if (bodyDesc != null && bodyDesc.isNotEmpty()) {
            sb.append("body:\n").append(bodyDesc)
        }
        return sb.toString()
    }

    private fun fieldsOf(node: GraphNode, tab: String): List<NodeField> {
        val f = node.fieldsOrEmpty()
        return when (tab) {
            "params" -> f.paramsOrEmpty()
            "headers" -> f.headersOrEmpty()
            else -> f.bodyOrEmpty()
        }
    }

    /**
     * JSON 바디 값의 타입 코어션. string/미지정은 기존 동작(네이티브) 유지(무회귀).
     * number/boolean/json/null 은 해석해 따옴표 없는 JSON 값으로. 해석 실패 시 원값 보존.
     */
    private fun coerceJson(v: Any?, type: String?): Any? {
        if (type == null || type.isBlank() || "string" == type) {
            return v
        }
        val s = tokens.stringify(v)
        return when (type) {
            "number" -> {
                val t = s.trim()
                try {
                    // 분리된 yield 로 Long/Double 타입을 각각 보존(삼항연산자는 double 로 승격시켜 30→30.0 이 됨)
                    if (t.contains(".") || t.contains("e") || t.contains("E")) {
                        t.toDouble()
                    } else {
                        t.toLong()
                    }
                } catch (e: NumberFormatException) {
                    v
                }
            }
            "boolean" -> {
                val t = s.trim()
                if ("true".equals(t, ignoreCase = true)) {
                    true
                } else if ("false".equals(t, ignoreCase = true)) {
                    false
                } else {
                    v
                }
            }
            "json", "object", "array" -> {
                try {
                    json.mapper().readValue(s, Any::class.java)
                } catch (e: Exception) {
                    v
                }
            }
            "null" -> null
            else -> v
        }
    }

    private data class RawResponse(val status: Int, val text: String, val byteLength: Int)

    /** 전송 전 조립된 HTTP 요청. client 모드에서 브라우저로 넘기는 페이로드의 원천이기도 하다. */
    data class BuiltRequest(
        val method: String,
        val url: String,
        val headers: Map<String, String>,
        val body: String?,
        val requestText: String,
        val reqValues: Map<String, Any?>
    )

    companion object {
        /** RFC 7230 토큰 — 유효한 HTTP 헤더 이름만 허용(나머지는 무시). */
        private val HEADER_NAME: Pattern = Pattern.compile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

        /**
         * respType=query 용 쿼리스트링 추출. URL/쿼리스트링은 <b>한 줄</b>이라는 전제 — 여러 줄 본문
         * (텍스트/HTML 에 '?' 가 섞인 경우)은 쿼리로 오인하지 않고 null(→ body 보존 폴백).
         * 한 줄이면: {@code ?} 가 있으면 그 뒤(프래그먼트 {@code #…} 는 제거), 없으면
         * {@code a=1&b=2} 형태(= 포함)일 때만 본문 자체를 쿼리로 본다.
         */
        internal fun extractQueryString(body: String?): String? {
            if (body == null) {
                return null
            }
            var t = body.trim()
            if (t.isEmpty() || t.contains('\n')) {
                return null
            }
            // '?' 를 먼저 찾고, 프래그먼트는 '?' 뒤에 오는 것만 제거 — 해시 라우팅 URL(https://x/#/cb?code=1)의
            // 파라미터가 프래그먼트 선제거로 유실되지 않게 한다.
            val q = t.indexOf('?')
            if (q >= 0) {
                var qs = t.substring(q + 1)
                val h = qs.indexOf('#')
                if (h >= 0) {
                    qs = qs.substring(0, h)
                }
                return qs
            }
            val hash = t.indexOf('#')
            if (hash >= 0) {
                t = t.substring(0, hash)
            }
            return if (t.contains('=')) t else null
        }

        @Suppress("UNCHECKED_CAST")
        private fun putMulti(map: MutableMap<String, Any?>, key: String, value: Any?) {
            val existing = map[key]
            if (existing == null) {
                map[key] = value
            } else if (existing is List<*>) {
                (existing as MutableList<Any?>).add(value)
            } else {
                val list = ArrayList<Any?>()
                list.add(existing)
                list.add(value)
                map[key] = list
            }
        }

        private fun dec(s: String, cs: Charset): String =
            try {
                URLDecoder.decode(s, cs)
            } catch (e: Exception) {
                s
            }

        private fun notBlank(s: String?): Boolean = s != null && !s.isBlank()

        private fun enc(s: String?, cs: Charset): String =
            URLEncoder.encode(s ?: "", cs)

        /** 노드 문자셋 이름을 Charset 으로(미지정/미지원이면 UTF-8). EUC-KR/MS949/US-ASCII 등 지원. */
        private fun charsetOf(name: String?): Charset {
            if (name == null || name.isBlank()) {
                return StandardCharsets.UTF_8
            }
            return try {
                Charset.forName(name.trim())
            } catch (e: Exception) {
                StandardCharsets.UTF_8
            }
        }

        /**
         * Content-Type 헤더에 쓸 charset 라벨. JVM 정규명이 비표준(x-)인 경우 IANA 등록명으로 보정한다.
         * 예: MS949 의 JVM 정규명은 {@code x-windows-949} 이지만, 비JVM 레거시(IIS/.NET/PHP)는
         * IANA 등록명 {@code windows-949} 만 인식한다. (바이트 인코딩 자체는 동일 Charset 이므로 영향 없음)
         */
        private fun wireCharset(cs: Charset): String {
            val n = cs.name()
            return if (n.equals("x-windows-949", ignoreCase = true)) "windows-949" else n
        }
    }
}
