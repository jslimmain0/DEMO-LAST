package com.flowlink.mock

import com.flowlink.common.json.JsonService
import com.flowlink.core.domain.MockServer
import com.flowlink.mock.MockHttp.MockRequest
import com.flowlink.mock.MockHttp.MockResponse
import jakarta.servlet.http.HttpServletRequest
import org.slf4j.LoggerFactory
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import java.util.ArrayList
import java.util.LinkedHashMap
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Mock 서빙 게이트웨이 — `/mock/{slug}` 이하 전 메서드 캐치올.
 * 무인증(외부 시스템 흉내) + CORS 전면 오픈(클라이언트 모드 노드가 브라우저에서 직접 호출).
 * 사용자 정의 라우트는 [MockRuntime]가 매칭·렌더한다.
 * 어떤 요청도 이 게이트웨이에서 예외로 새 나가지 않는다(전체 try/catch → 500 JSON).
 */
@RestController
class MockGatewayController(
    private val service: MockServerService,
    private val runtime: MockRuntime,
    private val dispatcher: MockCallbackDispatcher,
    private val json: JsonService
) {

    /** 템플릿 {{seq}} 용 서버별 카운터(인메모리 — 재시작 시 리셋). */
    private val seqs: MutableMap<UUID, AtomicLong> = ConcurrentHashMap()

    /** 서버별 파싱된 spec 캐시(raw JSON 이 그대로면 재파싱 생략 — mock 은 반복 호출되는 경로). */
    private val specCache: MutableMap<UUID, Pair<String, MockSpec>> = ConcurrentHashMap()

    @RequestMapping(path = ["/mock/{first}", "/mock/{first}/**"])
    fun handle(@PathVariable first: String, request: HttpServletRequest): ResponseEntity<ByteArray> {
        if ("OPTIONS".equals(request.method, ignoreCase = true)) {
            return withCors(ResponseEntity.noContent()).build()
        }
        return try {
            // slug 는 팀 스코프 — /mock/{tenant}/{slug}/… 우선, 실패 시 레거시 /mock/{slug}/…(default 테넌트)
            val resolved = MockPathResolver.resolve(request.requestURI) { t, s ->
                service.findForServing(t, s).orElse(null)
            } ?: return jsonError(404, "mock 서버가 없거나 비활성화됨: $first")
            val server = resolved.server
            val req = parse(resolved.pathPrefix, request)
            log.info("[mock:{}/{}] {} {}", server.tenantId, server.slug, req.method, req.path)

            val res = handleCustom(server, req)

            if (res.delayMs > 0) {
                try {
                    Thread.sleep(res.delayMs.toLong())
                } catch (ie: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }
            if (res.callback != null) {
                dispatcher.fire(res.callback)
            }
            val b = withCors(ResponseEntity.status(res.status))
                .header("Content-Type", res.contentType)
            res.headers.forEach { (k, v) -> b.header(k, v) }
            b.body(res.body)
        } catch (e: Exception) {
            log.warn("[mock:{}] 처리 오류: {}", first, if (e.message == null) e.toString() else e.message)
            jsonError(500, "mock 처리 오류: " + (if (e.message == null) e.toString() else e.message))
        }
    }

    private fun handleCustom(server: MockServer, req: MockRequest): MockResponse {
        val spec = cachedSpec(server)
        if ("/__routes" == req.path) {
            val routes = spec.routesOrEmpty().map { r ->
                mapOf(
                    "method" to (r.method ?: "ANY"),
                    "path" to (r.path ?: ""),
                    "rules" to r.rulesOrEmpty().size
                )
            }
            return MockResponse.of(
                200, "application/json; charset=UTF-8",
                json.toJson(mapOf("kind" to "CUSTOM", "routes" to routes)).toByteArray(StandardCharsets.UTF_8)
            )
        }
        val match = runtime.match(spec.routesOrEmpty(), req)
        if (match.isEmpty) {
            return MockResponse.of(
                404, "application/json; charset=UTF-8",
                json.toJson(mapOf("error" to "매칭되는 mock 라우트가 없습니다: " + req.method + " " + req.path))
                    .toByteArray(StandardCharsets.UTF_8)
            )
        }
        val seq = seqs.computeIfAbsent(server.id) { AtomicLong(1000) }.incrementAndGet()
        return runtime.render(match.get().rule, req, match.get().pathParams, seq)
    }

    /** raw spec JSON 이 캐시된 것과 같으면 파싱 결과 재사용, 아니면 재파싱(저장 즉시 반영 유지). */
    private fun cachedSpec(server: MockServer): MockSpec {
        val raw = server.specJson ?: ""
        val hit = specCache[server.id]
        if (hit != null && hit.first == raw) {
            return hit.second
        }
        val spec = service.parseSpec(raw)
        specCache[server.id] = raw to spec
        return spec
    }

    // ---------- 요청 파싱 ----------

    private fun parse(prefix: String, request: HttpServletRequest): MockRequest {
        val raw = request.requestURI
        val rawPath = if (raw.length > prefix.length) raw.substring(prefix.length) else "/"
        val path = MockHttp.decodePath(rawPath)

        val query = MockHttp.parseUrlEncoded(request.queryString, StandardCharsets.UTF_8)

        val headers = LinkedHashMap<String, String>()
        val names = request.headerNames
        while (names != null && names.hasMoreElements()) {
            val n = names.nextElement()
            headers.putIfAbsent(n.lowercase(Locale.ROOT), request.getHeader(n))
        }

        val bytes = request.inputStream.readAllBytes()
        val ct = headers.getOrDefault("content-type", "")
        val cs = MockHttp.charsetFromContentType(ct)
        var bodyText = if (bytes.isEmpty()) "" else String(bytes, cs)
        var bodyFields = parseBodyFields(bodyText, ct, cs)

        // Spring FormContentFilter 는 PUT/PATCH/DELETE + urlencoded 본문을 미리 읽어 파라미터로 노출한다
        // → getInputStream() 이 빈 값이 된다. 그 경우 파라미터 맵에서 쿼리 유래를 뺀 나머지를 본문 필드로 복원.
        if (bytes.isEmpty() && ct.lowercase(Locale.ROOT).contains("urlencoded")) {
            val recovered = recoverFormBody(request, query)
            if (recovered.isNotEmpty()) {
                bodyFields = recovered
                bodyText = MockHttp.toUrlEncoded(ArrayList(recovered.entries))
            }
        }

        return MockRequest(request.method.uppercase(Locale.ROOT), path, query, headers, bodyText, bodyFields)
    }

    /** FormContentFilter 가 소진한 urlencoded 본문을 파라미터 맵에서 복원(쿼리 유래 키/값은 제외). */
    private fun recoverFormBody(request: HttpServletRequest, query: Map<String, String>): Map<String, String> {
        val form = LinkedHashMap<String, String>()
        val params = request.parameterMap ?: return form
        for ((k, v) in params) {
            val value = if (v != null && v.isNotEmpty()) v[0] else ""
            // 쿼리스트링에 같은 값으로 이미 있으면 쿼리 유래로 보고 제외(본문 값만 남긴다)
            if (query.containsKey(k) && query[k] == value) {
                continue
            }
            form[k] = value
        }
        return form
    }

    private fun parseBodyFields(bodyText: String, contentType: String, cs: Charset): Map<String, String> {
        if (bodyText.isBlank()) {
            return emptyMap()
        }
        val ct = contentType.lowercase(Locale.ROOT)
        if (ct.contains("json") || (!ct.contains("urlencoded") && bodyText.trim().startsWith("{"))) {
            try {
                val node = json.mapper().readTree(bodyText)
                if (node != null && node.isObject) {
                    val out = LinkedHashMap<String, String>()
                    node.fields().forEachRemaining { e ->
                        out[e.key] = if (e.value.isTextual) e.value.asText() else e.value.toString()
                    }
                    return out
                }
            } catch (ignored: Exception) {
                // JSON 아님 — urlencoded 폴백
            }
        }
        if (bodyText.contains("=")) {
            return MockHttp.parseUrlEncoded(bodyText, cs)
        }
        return emptyMap()
    }

    private fun withCors(b: ResponseEntity.HeadersBuilder<*>): ResponseEntity.BodyBuilder =
        (b as ResponseEntity.BodyBuilder)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "*")
            .header("Access-Control-Allow-Headers", "*")

    private fun jsonError(status: Int, message: String): ResponseEntity<ByteArray> =
        withCors(ResponseEntity.status(status))
            .header("Content-Type", "application/json; charset=UTF-8")
            .body(json.toJson(mapOf("error" to message)).toByteArray(StandardCharsets.UTF_8))

    companion object {
        private val log = LoggerFactory.getLogger(MockGatewayController::class.java)
    }
}
