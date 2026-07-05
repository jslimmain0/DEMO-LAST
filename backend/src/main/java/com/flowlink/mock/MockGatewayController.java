package com.flowlink.mock;

import com.fasterxml.jackson.databind.JsonNode;
import com.flowlink.common.json.JsonService;
import com.flowlink.core.domain.MockServer;
import com.flowlink.mock.MockHttp.MockRequest;
import com.flowlink.mock.MockHttp.MockResponse;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Mock 서빙 게이트웨이 — {@code /mock/{slug}/**} 전 메서드 캐치올.
 * 무인증(외부 시스템 흉내) + CORS 전면 오픈(클라이언트 모드 노드가 브라우저에서 직접 호출).
 * 사용자 정의 라우트는 {@link MockRuntime}가 매칭·렌더한다.
 * 어떤 요청도 이 게이트웨이에서 예외로 새 나가지 않는다(전체 try/catch → 500 JSON).
 */
@RestController
public class MockGatewayController {

    private static final Logger log = LoggerFactory.getLogger(MockGatewayController.class);

    private final MockServerService service;
    private final MockRuntime runtime;
    private final MockCallbackDispatcher dispatcher;
    private final JsonService json;
    /** 템플릿 {{seq}} 용 서버별 카운터(인메모리 — 재시작 시 리셋). */
    private final Map<UUID, AtomicLong> seqs = new ConcurrentHashMap<>();
    /** 서버별 파싱된 spec 캐시(raw JSON 이 그대로면 재파싱 생략 — mock 은 반복 호출되는 경로). */
    private final Map<UUID, Map.Entry<String, MockSpec>> specCache = new ConcurrentHashMap<>();

    public MockGatewayController(MockServerService service, MockRuntime runtime,
                                 MockCallbackDispatcher dispatcher, JsonService json) {
        this.service = service;
        this.runtime = runtime;
        this.dispatcher = dispatcher;
        this.json = json;
    }

    @RequestMapping(path = {"/mock/{slug}", "/mock/{slug}/**"})
    public ResponseEntity<byte[]> handle(@PathVariable String slug, HttpServletRequest request) {
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return withCors(ResponseEntity.noContent()).build();
        }
        try {
            Optional<MockServer> found = service.findForServing(slug);
            if (found.isEmpty()) {
                return jsonError(404, "mock 서버가 없거나 비활성화됨: " + slug);
            }
            MockServer server = found.get();
            MockRequest req = parse(slug, request);
            log.info("[mock:{}] {} {}", slug, req.method(), req.path());

            MockResponse res = handleCustom(server, req);

            if (res.delayMs() > 0) {
                try {
                    Thread.sleep(res.delayMs());
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                }
            }
            if (res.callback() != null) {
                dispatcher.fire(res.callback());
            }
            ResponseEntity.BodyBuilder b = withCors(ResponseEntity.status(res.status()))
                    .header("Content-Type", res.contentType());
            res.headers().forEach(b::header);
            return b.body(res.body());
        } catch (Exception e) {
            log.warn("[mock:{}] 처리 오류: {}", slug, e.getMessage() == null ? e.toString() : e.getMessage());
            return jsonError(500, "mock 처리 오류: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    private MockResponse handleCustom(MockServer server, MockRequest req) {
        MockSpec spec = cachedSpec(server);
        if ("/__routes".equals(req.path())) {
            List<Map<String, Object>> routes = spec.routesOrEmpty().stream()
                    .<Map<String, Object>>map(r -> Map.of(
                            "method", r.getMethod() == null ? "ANY" : r.getMethod(),
                            "path", r.getPath() == null ? "" : r.getPath(),
                            "rules", r.rulesOrEmpty().size()))
                    .toList();
            return MockResponse.of(200, "application/json; charset=UTF-8",
                    json.toJson(Map.of("kind", "CUSTOM", "routes", routes)).getBytes(StandardCharsets.UTF_8));
        }
        var match = runtime.match(spec.routesOrEmpty(), req);
        if (match.isEmpty()) {
            return MockResponse.of(404, "application/json; charset=UTF-8",
                    json.toJson(Map.of("error", "매칭되는 mock 라우트가 없습니다: " + req.method() + " " + req.path()))
                            .getBytes(StandardCharsets.UTF_8));
        }
        long seq = seqs.computeIfAbsent(server.getId(), k -> new AtomicLong(1000)).incrementAndGet();
        return runtime.render(match.get().rule(), req, match.get().pathParams(), seq);
    }

    /** raw spec JSON 이 캐시된 것과 같으면 파싱 결과 재사용, 아니면 재파싱(저장 즉시 반영 유지). */
    private MockSpec cachedSpec(MockServer server) {
        String raw = server.getSpecJson() == null ? "" : server.getSpecJson();
        Map.Entry<String, MockSpec> hit = specCache.get(server.getId());
        if (hit != null && hit.getKey().equals(raw)) {
            return hit.getValue();
        }
        MockSpec spec = service.parseSpec(raw);
        specCache.put(server.getId(), Map.entry(raw, spec));
        return spec;
    }

    // ---------- 요청 파싱 ----------

    private MockRequest parse(String slug, HttpServletRequest request) throws java.io.IOException {
        String raw = request.getRequestURI();
        String prefix = "/mock/" + slug;
        String rawPath = raw.length() > prefix.length() ? raw.substring(prefix.length()) : "/";
        String path = MockHttp.decodePath(rawPath);

        Map<String, String> query = MockHttp.parseUrlEncoded(request.getQueryString(), StandardCharsets.UTF_8);

        Map<String, String> headers = new LinkedHashMap<>();
        var names = request.getHeaderNames();
        while (names != null && names.hasMoreElements()) {
            String n = names.nextElement();
            headers.putIfAbsent(n.toLowerCase(Locale.ROOT), request.getHeader(n));
        }

        byte[] bytes = request.getInputStream().readAllBytes();
        String ct = headers.getOrDefault("content-type", "");
        Charset cs = MockHttp.charsetFromContentType(ct);
        String bodyText = bytes.length == 0 ? "" : new String(bytes, cs);
        Map<String, String> bodyFields = parseBodyFields(bodyText, ct, cs);

        // Spring FormContentFilter 는 PUT/PATCH/DELETE + urlencoded 본문을 미리 읽어 파라미터로 노출한다
        // → getInputStream() 이 빈 값이 된다. 그 경우 파라미터 맵에서 쿼리 유래를 뺀 나머지를 본문 필드로 복원.
        if (bytes.length == 0 && ct.toLowerCase(Locale.ROOT).contains("urlencoded")) {
            Map<String, String> recovered = recoverFormBody(request, query);
            if (!recovered.isEmpty()) {
                bodyFields = recovered;
                bodyText = MockHttp.toUrlEncoded(new ArrayList<>(recovered.entrySet()));
            }
        }

        return new MockRequest(request.getMethod().toUpperCase(Locale.ROOT), path, query, headers, bodyText, bodyFields);
    }

    /** FormContentFilter 가 소진한 urlencoded 본문을 파라미터 맵에서 복원(쿼리 유래 키/값은 제외). */
    private static Map<String, String> recoverFormBody(HttpServletRequest request, Map<String, String> query) {
        Map<String, String> form = new LinkedHashMap<>();
        Map<String, String[]> params = request.getParameterMap();
        if (params == null) {
            return form;
        }
        for (Map.Entry<String, String[]> e : params.entrySet()) {
            String k = e.getKey();
            String v = e.getValue() != null && e.getValue().length > 0 ? e.getValue()[0] : "";
            // 쿼리스트링에 같은 값으로 이미 있으면 쿼리 유래로 보고 제외(본문 값만 남긴다)
            if (query.containsKey(k) && query.get(k).equals(v)) {
                continue;
            }
            form.put(k, v);
        }
        return form;
    }

    private Map<String, String> parseBodyFields(String bodyText, String contentType, Charset cs) {
        if (bodyText == null || bodyText.isBlank()) {
            return Map.of();
        }
        String ct = contentType.toLowerCase(Locale.ROOT);
        if (ct.contains("json") || (!ct.contains("urlencoded") && bodyText.trim().startsWith("{"))) {
            try {
                JsonNode node = json.mapper().readTree(bodyText);
                if (node != null && node.isObject()) {
                    Map<String, String> out = new LinkedHashMap<>();
                    node.fields().forEachRemaining(e ->
                            out.put(e.getKey(), e.getValue().isTextual() ? e.getValue().asText() : e.getValue().toString()));
                    return out;
                }
            } catch (Exception ignored) {
                // JSON 아님 — urlencoded 폴백
            }
        }
        if (bodyText.contains("=")) {
            return MockHttp.parseUrlEncoded(bodyText, cs);
        }
        return Map.of();
    }

    private ResponseEntity.BodyBuilder withCors(ResponseEntity.HeadersBuilder<?> b) {
        return ((ResponseEntity.BodyBuilder) b)
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "*")
                .header("Access-Control-Allow-Headers", "*");
    }

    private ResponseEntity<byte[]> jsonError(int status, String message) {
        return withCors(ResponseEntity.status(status))
                .header("Content-Type", "application/json; charset=UTF-8")
                .body(json.toJson(Map.of("error", message)).getBytes(StandardCharsets.UTF_8));
    }
}
