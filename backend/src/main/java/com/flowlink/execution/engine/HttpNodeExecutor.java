package com.flowlink.execution.engine;

import com.flowlink.common.json.JsonService;
import com.flowlink.core.graph.GraphNode;
import com.flowlink.core.graph.NodeField;
import com.flowlink.execution.config.ExecutionProperties;
import com.flowlink.execution.config.HttpClientConfig;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * HTTP 요청 노드를 <b>서버사이드</b>로 실행한다. (프로토타입은 브라우저 fetch → CORS 한계,
 * 시크릿 노출. 서버 실행으로 그 한계를 제거하되 SSRF 가드를 강제.)
 */
@Component
public class HttpNodeExecutor {

    /** RFC 7230 토큰 — 유효한 HTTP 헤더 이름만 허용(나머지는 무시). */
    private static final Pattern HEADER_NAME = Pattern.compile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$");

    private final RestClient restClient;
    private final TokenResolver tokens;
    private final SsrfGuard ssrfGuard;
    private final JsonService json;
    private final long maxResponseBytes;

    public HttpNodeExecutor(@Qualifier(HttpClientConfig.NODE_REST_CLIENT) RestClient restClient,
                            TokenResolver tokens, SsrfGuard ssrfGuard, JsonService json,
                            ExecutionProperties props) {
        this.restClient = restClient;
        this.tokens = tokens;
        this.ssrfGuard = ssrfGuard;
        this.json = json;
        this.maxResponseBytes = props.http().maxResponseBytes();
    }

    public NodeResult execute(GraphNode node, ExecutionContext ctx) {
        var fields = node.fieldsOrEmpty();

        // 1) 요청값 수집(req: 스코프로 다운스트림에 노출)
        Map<String, Object> reqValues = new LinkedHashMap<>();
        for (String tab : List.of("params", "headers", "body")) {
            for (NodeField f : fieldsOf(node, tab)) {
                if (notBlank(f.key())) {
                    reqValues.put(f.key(), tokens.fieldValue(f, ctx));
                }
            }
        }

        // 2) URL
        String base = node.baseUrlBound() != null
                ? tokens.stringify(tokens.resolveBinding(node.baseUrlBound(), ctx))
                : tokens.resolveTokens(node.baseUrl() == null ? "" : node.baseUrl(), ctx);
        String url = base + tokens.resolveTokens(node.path() == null ? "" : node.path(), ctx);

        String method = node.method() == null ? "GET" : node.method().toUpperCase();

        // 3) 헤더
        Map<String, String> headers = new LinkedHashMap<>();
        StringBuilder skipped = new StringBuilder();
        for (NodeField f : fields.headersOrEmpty()) {
            String k = f.key() == null ? "" : f.key().trim();
            if (k.isEmpty()) {
                continue;
            }
            if (!HEADER_NAME.matcher(k).matches()) {
                skipped.append(skipped.isEmpty() ? "" : ", ").append(k);
                continue;
            }
            headers.put(k, tokens.stringify(tokens.fieldValue(f, ctx)).replaceAll("[\\r\\n]+", " "));
        }

        // 4) 쿼리 파라미터
        StringBuilder qs = new StringBuilder();
        for (NodeField f : fields.paramsOrEmpty()) {
            if (notBlank(f.key())) {
                if (!qs.isEmpty()) {
                    qs.append('&');
                }
                qs.append(enc(f.key())).append('=').append(enc(tokens.stringify(tokens.fieldValue(f, ctx))));
            }
        }
        if (!qs.isEmpty()) {
            url += (url.indexOf('?') >= 0 ? "&" : "?") + qs;
        }

        // 5) 바디(GET/HEAD 제외)
        String bodyString = null;
        String bodyDesc = "";
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            String bt = node.bodyType() == null ? "json" : node.bodyType();
            switch (bt) {
                case "json" -> {
                    if (Boolean.TRUE.equals(node.jsonRaw())) {
                        bodyString = tokens.resolveTokens(node.rawBody() == null ? "" : node.rawBody(), ctx);
                    } else {
                        Map<String, Object> obj = new LinkedHashMap<>();
                        for (NodeField f : fields.bodyOrEmpty()) {
                            if (notBlank(f.key())) {
                                obj.put(f.key(), tokens.fieldValue(f, ctx));
                            }
                        }
                        bodyString = json.toJson(obj);
                    }
                    headers.putIfAbsent("Content-Type", "application/json");
                }
                case "urlencoded", "form" -> {
                    StringBuilder b = new StringBuilder();
                    for (NodeField f : fields.bodyOrEmpty()) {
                        if (notBlank(f.key())) {
                            if (!b.isEmpty()) {
                                b.append('&');
                            }
                            b.append(enc(f.key())).append('=').append(enc(tokens.stringify(tokens.fieldValue(f, ctx))));
                        }
                    }
                    bodyString = b.toString();
                    // NOTE: multipart(form-data)는 후속 Phase. 현재는 urlencoded 로 처리.
                    headers.putIfAbsent("Content-Type", "application/x-www-form-urlencoded");
                }
                case "raw", "xml" -> {
                    bodyString = tokens.resolveTokens(node.rawBody() == null ? "" : node.rawBody(), ctx);
                    if ("xml".equals(bt)) {
                        headers.putIfAbsent("Content-Type", "application/xml");
                    }
                }
                default -> bodyString = tokens.resolveTokens(node.rawBody() == null ? "" : node.rawBody(), ctx);
            }
            bodyDesc = bodyString == null ? "" : bodyString;
        }

        String reqStr = buildRequestText(method, url, headers, bodyDesc, skipped.toString());

        // 6) SSRF 가드 + 전송
        final URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException e) {
            return NodeResult.fail(0, reqStr, "⚠ 잘못된 URL: " + e.getMessage());
        }
        try {
            ssrfGuard.check(uri);
        } catch (SsrfBlockedException e) {
            return NodeResult.fail(0, reqStr, "⚠ 차단됨(SSRF 가드): " + e.getMessage());
        }

        try {
            final Map<String, String> finalHeaders = headers;
            var spec = restClient.method(HttpMethod.valueOf(method)).uri(uri)
                    .headers(h -> finalHeaders.forEach(h::set));
            RawResponse raw = (bodyString != null ? spec.body(bodyString) : spec)
                    .exchange((request, response) -> readRaw(response));

            Object value = parseResponse(node.respType(), raw);
            return NodeResult.okHttp(raw.status(), reqStr, raw.text(), value, reqValues);
        } catch (Exception e) {
            return NodeResult.fail(0, reqStr, "⚠ 요청 실패: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    private RawResponse readRaw(RestClient.RequestHeadersSpec.ConvertibleClientHttpResponse response) throws IOException {
        int status = response.getStatusCode().value();
        try (InputStream in = response.getBody()) {
            int cap = (int) Math.min(maxResponseBytes + 1, Integer.MAX_VALUE);
            byte[] bytes = in.readNBytes(cap);
            boolean truncated = bytes.length > maxResponseBytes;
            if (truncated) {
                bytes = Arrays.copyOf(bytes, (int) maxResponseBytes);
            }
            return new RawResponse(status, new String(bytes, StandardCharsets.UTF_8), truncated);
        }
    }

    private Object parseResponse(String respType, RawResponse raw) {
        String rt = respType == null ? "json" : respType;
        return switch (rt) {
            case "json" -> {
                try {
                    yield json.mapper().readValue(raw.text(), Object.class);
                } catch (Exception e) {
                    yield Map.of("body", raw.text());
                }
            }
            case "binary" -> Map.of("body", "(binary · " + raw.text().length() + " bytes)");
            default -> Map.of("body", raw.text()); // text, xml
        };
    }

    private String buildRequestText(String method, String url, Map<String, String> headers,
                                    String bodyDesc, String skipped) {
        StringBuilder sb = new StringBuilder();
        if (!skipped.isEmpty()) {
            sb.append("⚠ 잘못된 헤더 이름이라 무시됨: ").append(skipped).append('\n');
        }
        sb.append(method).append(' ').append(url).append('\n');
        if (!headers.isEmpty()) {
            sb.append("headers: ").append(json.toJson(headers)).append('\n');
        }
        if (bodyDesc != null && !bodyDesc.isEmpty()) {
            sb.append("body:\n").append(bodyDesc);
        }
        return sb.toString();
    }

    private List<NodeField> fieldsOf(GraphNode node, String tab) {
        var f = node.fieldsOrEmpty();
        return switch (tab) {
            case "params" -> f.paramsOrEmpty();
            case "headers" -> f.headersOrEmpty();
            default -> f.bodyOrEmpty();
        };
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }

    private static String enc(String s) {
        return URLEncoder.encode(s == null ? "" : s, StandardCharsets.UTF_8);
    }

    private record RawResponse(int status, String text, boolean truncated) {
    }
}
