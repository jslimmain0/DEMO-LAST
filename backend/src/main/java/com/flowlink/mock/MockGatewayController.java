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

import java.net.URLDecoder;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
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
 * CUSTOM 은 {@link MockRuntime}, PG 프리셋은 {@link MockPgSimulator}가 처리한다.
 * 어떤 요청도 이 게이트웨이에서 예외로 새 나가지 않는다(전체 try/catch → 500 JSON).
 */
@RestController
public class MockGatewayController {

    private static final Logger log = LoggerFactory.getLogger(MockGatewayController.class);

    private final MockServerService service;
    private final MockRuntime runtime;
    private final MockPgSimulator pg;
    private final MockCallbackDispatcher dispatcher;
    private final JsonService json;
    /** CUSTOM 템플릿 {{seq}} 용 서버별 카운터(인메모리 — 재시작 시 리셋). */
    private final Map<UUID, AtomicLong> seqs = new ConcurrentHashMap<>();

    public MockGatewayController(MockServerService service, MockRuntime runtime,
                                 MockPgSimulator pg, MockCallbackDispatcher dispatcher, JsonService json) {
        this.service = service;
        this.runtime = runtime;
        this.pg = pg;
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

            MockResponse res;
            if (server.getKind() == MockServer.Kind.PG) {
                MockSpec spec = service.parseSpec(server.getSpecJson());
                String secret = spec.secret() == null || spec.secret().isBlank()
                        ? MockPgSimulator.DEFAULT_SECRET : spec.secret();
                res = pg.handle(server.getId(), slug, req, secret);
            } else {
                res = handleCustom(server, req);
            }

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
        MockSpec spec = service.parseSpec(server.getSpecJson());
        if ("/__routes".equals(req.path())) {
            List<Map<String, Object>> routes = spec.routesOrEmpty().stream()
                    .<Map<String, Object>>map(r -> Map.of(
                            "method", r.method() == null ? "ANY" : r.method(),
                            "path", r.path() == null ? "" : r.path(),
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

    // ---------- 요청 파싱 ----------

    private MockRequest parse(String slug, HttpServletRequest request) throws java.io.IOException {
        String raw = request.getRequestURI();
        String prefix = "/mock/" + slug;
        String path = raw.length() > prefix.length() ? raw.substring(prefix.length()) : "/";
        try {
            path = URLDecoder.decode(path, StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            // malformed percent-encoding — 원문 그대로 매칭
        }
        if (path.isEmpty()) {
            path = "/";
        }

        Map<String, String> query = MockHttp.parseUrlEncoded(request.getQueryString(), StandardCharsets.UTF_8);

        Map<String, String> headers = new LinkedHashMap<>();
        var names = request.getHeaderNames();
        while (names != null && names.hasMoreElements()) {
            String n = names.nextElement();
            headers.putIfAbsent(n.toLowerCase(Locale.ROOT), request.getHeader(n));
        }

        byte[] bytes = request.getInputStream().readAllBytes();
        String ct = headers.getOrDefault("content-type", "");
        Charset cs = charsetFromContentType(ct);
        String bodyText = bytes.length == 0 ? "" : new String(bytes, cs);
        Map<String, String> bodyFields = parseBodyFields(bodyText, ct, cs);

        return new MockRequest(request.getMethod().toUpperCase(Locale.ROOT), path, query, headers, bodyText, bodyFields);
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

    static Charset charsetFromContentType(String contentType) {
        if (contentType == null) {
            return StandardCharsets.UTF_8;
        }
        int i = contentType.toLowerCase(Locale.ROOT).indexOf("charset=");
        if (i < 0) {
            return StandardCharsets.UTF_8;
        }
        String name = contentType.substring(i + "charset=".length()).trim();
        int semi = name.indexOf(';');
        if (semi >= 0) {
            name = name.substring(0, semi);
        }
        name = name.replace("\"", "").trim();
        // 레거시 별칭 보정 — HttpNodeExecutor.wireCharset 의 역방향
        if (name.equalsIgnoreCase("windows-949")) {
            name = "x-windows-949";
        }
        return MockHttp.charsetOf(name);
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
