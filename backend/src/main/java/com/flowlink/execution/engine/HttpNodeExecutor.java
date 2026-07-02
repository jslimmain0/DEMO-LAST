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

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.IOException;
import java.io.InputStream;
import java.io.StringReader;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
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

    /**
     * 한 노드의 HTTP 요청을 <b>조립만</b> 한다(전송하지 않음). server/client 모드 공통.
     * client 모드는 이 결과를 브라우저로 넘겨 직접 호출하게 하고, server 모드는 그대로 전송한다.
     */
    public BuiltRequest build(GraphNode node, ExecutionContext ctx) {
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
        Charset cs = charsetOf(node.charset()); // 요청 인코딩·응답 디코딩 문자셋(기본 UTF-8)

        // 3) 헤더 — 필드 또는 Raw(Key: Value 줄바꿈)
        Map<String, String> headers = new LinkedHashMap<>();
        StringBuilder skipped = new StringBuilder();
        if (Boolean.TRUE.equals(node.headersRaw())) {
            String rawH = node.rawHeaders() == null ? "" : node.rawHeaders();
            for (String line : rawH.split("\\r?\\n")) {
                String l = line.trim();
                if (l.isEmpty()) {
                    continue;
                }
                int i = l.indexOf(':');
                if (i < 0) {
                    continue;
                }
                String k = l.substring(0, i).trim();
                if (k.isEmpty()) {
                    continue;
                }
                if (!HEADER_NAME.matcher(k).matches()) {
                    skipped.append(skipped.isEmpty() ? "" : ", ").append(k);
                    continue;
                }
                String v = tokens.resolveTokens(l.substring(i + 1).trim(), ctx);
                headers.put(k, v.replaceAll("[\\r\\n]+", " "));
            }
        } else {
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
        }

        // 4) 쿼리 파라미터 — 필드 또는 Raw(a=1&b=2 원문)
        String qsStr;
        if (Boolean.TRUE.equals(node.paramsRaw())) {
            // Raw 모드: 토큰만 치환하고 원문 그대로 사용(인코딩은 사용자 책임 — 바디 urlencoded raw 와 동일 규약)
            qsStr = tokens.resolveTokens(node.rawParams() == null ? "" : node.rawParams(), ctx).trim();
        } else {
            StringBuilder qs = new StringBuilder();
            for (NodeField f : fields.paramsOrEmpty()) {
                if (notBlank(f.key())) {
                    if (!qs.isEmpty()) {
                        qs.append('&');
                    }
                    qs.append(enc(f.key(), cs)).append('=').append(enc(tokens.stringify(tokens.fieldValue(f, ctx)), cs));
                }
            }
            qsStr = qs.toString();
        }
        if (!qsStr.isEmpty()) {
            url += (url.indexOf('?') >= 0 ? "&" : "?") + qsStr;
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
                                // 필드 타입에 따라 따옴표 여부 결정: number/boolean/json 은 코어션, string/미지정은 기존 동작
                                obj.put(f.key(), coerceJson(tokens.fieldValue(f, ctx), f.type()));
                            }
                        }
                        bodyString = json.toJson(obj);
                    }
                    headers.putIfAbsent("Content-Type", "application/json");
                }
                case "urlencoded", "form" -> {
                    if (Boolean.TRUE.equals(node.jsonRaw())) {
                        // Raw 모드: 본문을 직접 입력(a=1&b=2). 토큰만 치환하고 그대로 전송.
                        bodyString = tokens.resolveTokens(node.rawBody() == null ? "" : node.rawBody(), ctx);
                    } else {
                        StringBuilder b = new StringBuilder();
                        for (NodeField f : fields.bodyOrEmpty()) {
                            if (notBlank(f.key())) {
                                if (!b.isEmpty()) {
                                    b.append('&');
                                }
                                b.append(enc(f.key(), cs)).append('=').append(enc(tokens.stringify(tokens.fieldValue(f, ctx)), cs));
                            }
                        }
                        bodyString = b.toString();
                    }
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

        // 비UTF-8 문자셋이면 본문 Content-Type 에 charset 을 명시(서버가 올바르게 해석하도록).
        // 단 client 모드는 브라우저 fetch 가 본문을 UTF-8 로 보내므로(헤더 charset 무시) 잘못된 주장 방지 위해 미부착.
        boolean clientMode = "client".equalsIgnoreCase(node.reqMode());
        if (bodyString != null && !cs.equals(StandardCharsets.UTF_8) && !clientMode) {
            String ct = headers.get("Content-Type");
            if (ct != null && !ct.toLowerCase().contains("charset")) {
                headers.put("Content-Type", ct + "; charset=" + wireCharset(cs));
            }
        }

        String reqStr = buildRequestText(method, url, headers, bodyDesc, skipped.toString());
        return new BuiltRequest(method, url, headers, bodyString, reqStr, reqValues);
    }

    /** server 모드: 서버가 직접 호출한다(SSRF 가드 강제). */
    public NodeResult execute(GraphNode node, ExecutionContext ctx) {
        BuiltRequest req = build(node, ctx);

        final URI uri;
        try {
            uri = URI.create(req.url());
        } catch (IllegalArgumentException e) {
            return NodeResult.fail(0, req.requestText(), "⚠ 잘못된 URL: " + e.getMessage());
        }
        try {
            ssrfGuard.check(uri);
        } catch (SsrfBlockedException e) {
            return NodeResult.fail(0, req.requestText(), "⚠ 차단됨(SSRF 가드): " + e.getMessage());
        }

        try {
            final Charset cs = charsetOf(node.charset());
            final Map<String, String> finalHeaders = req.headers();
            var spec = restClient.method(HttpMethod.valueOf(req.method())).uri(uri)
                    .headers(h -> finalHeaders.forEach(h::set));
            // 본문은 선택 문자셋으로 인코딩한 바이트로 전송(UTF-8이면 기존과 동일). 응답도 같은 문자셋으로 디코딩.
            RawResponse raw = (req.body() != null ? spec.body(req.body().getBytes(cs)) : spec)
                    .exchange((request, response) -> readRaw(response, cs));

            Object value = parseResponse(node.respType(), raw, cs);
            return NodeResult.okHttp(raw.status(), req.requestText(), raw.text(), value, req.reqValues());
        } catch (Exception e) {
            return NodeResult.fail(0, req.requestText(), "⚠ 요청 실패: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    /**
     * client 모드: 브라우저가 대신 호출하고 돌려준 결과({@code status}/{@code body})를 NodeResult 로 변환한다.
     * 서버는 전송하지 않으므로 SSRF 가드 대상이 아니다(브라우저의 동일출처/CORS 정책이 적용됨).
     */
    public NodeResult clientResult(GraphNode node, BuiltRequest req, int status, String body, String error) {
        if (error != null && !error.isBlank()) {
            return NodeResult.fail(status > 0 ? status : 0, req.requestText(), "⚠ 클라이언트 요청 실패: " + error);
        }
        String text = body == null ? "" : body;
        // client 모드는 브라우저가 이미 디코딩한 문자열을 받으므로 form 퍼센트 디코딩은 UTF-8 기준
        Object value = parseResponse(node.respType(),
                new RawResponse(status, text, false, text.getBytes(StandardCharsets.UTF_8).length), StandardCharsets.UTF_8);
        return NodeResult.okHttp(status, req.requestText(), text, value, req.reqValues());
    }

    private RawResponse readRaw(RestClient.RequestHeadersSpec.ConvertibleClientHttpResponse response, Charset cs) throws IOException {
        int status = response.getStatusCode().value();
        try (InputStream in = response.getBody()) {
            int cap = (int) Math.min(maxResponseBytes + 1, Integer.MAX_VALUE);
            byte[] bytes = in.readNBytes(cap);
            boolean truncated = bytes.length > maxResponseBytes;
            if (truncated) {
                bytes = Arrays.copyOf(bytes, (int) maxResponseBytes);
            }
            return new RawResponse(status, new String(bytes, cs), truncated, bytes.length);
        }
    }

    /**
     * 응답 본문을 노드의 respType 에 맞는 "키-값 맵"으로 해석한다. 하위 노드는 이 맵의 키로 바인딩한다.
     * <ul>
     *   <li><b>json</b>: JSON 파싱(객체/배열)</li>
     *   <li><b>form</b>: {@code a=1&b=2} urlencoded → 키-값(중복 키는 리스트)</li>
     *   <li><b>xml</b>: 루트의 최상위 자식 엘리먼트명 → 텍스트(중복은 리스트). 평면 XML(코드/메시지 등)에 적합</li>
     *   <li><b>text/binary</b>: 키가 없으므로 본문 전체를 {@code body} 한 키로 제공</li>
     * </ul>
     * 어떤 타입이든 파싱 실패 시 본문을 {@code body} 로 보존한다(데이터 유실 방지).
     */
    private Object parseResponse(String respType, RawResponse raw, Charset cs) {
        String rt = respType == null ? "json" : respType;
        return switch (rt) {
            case "json" -> {
                try {
                    Object v = json.mapper().readValue(raw.text(), Object.class);
                    if (v instanceof Map || v instanceof List) {
                        yield v; // 객체/배열은 그대로(키 바인딩·배열 첫 원소 규약 유지)
                    }
                    // 스칼라(숫자/문자열/불리언/null)는 map.get(key) 로 풀리지 않으므로 body 로 감싼다.
                    // 파싱된 값을 담아 문자열은 따옴표 없이 제공(null 만 원문 "null" 보존).
                    yield Map.of("body", v == null ? raw.text() : v);
                } catch (Exception e) {
                    yield Map.of("body", raw.text());
                }
            }
            case "form", "urlencoded" -> parseForm(raw.text(), cs);
            case "xml" -> parseXml(raw.text());
            case "binary" -> Map.of("body", "(binary · " + raw.byteLength() + " bytes)");
            default -> Map.of("body", raw.text()); // text — 본문 전체를 body 로
        };
    }

    /** application/x-www-form-urlencoded 응답을 키-값 맵으로 파싱(중복 키는 리스트로 누적). 퍼센트 디코딩은 cs 문자셋. */
    private Map<String, Object> parseForm(String body, Charset cs) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (body == null || body.isBlank()) {
            return out;
        }
        for (String pair : body.split("&")) {
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String k = dec(eq >= 0 ? pair.substring(0, eq) : pair, cs);
            String v = dec(eq >= 0 ? pair.substring(eq + 1) : "", cs);
            if (!k.isEmpty()) {
                putMulti(out, k, v);
            }
        }
        return out;
    }

    /**
     * XML 응답을 키-값 맵으로 파싱. 루트의 자식 요소들을 키로 삼되, 자식 요소를 더 가진 요소는 중첩 맵으로
     * 재귀 변환하고(중복은 리스트), 잎 요소는 텍스트를 trim 해서 담는다(프리티프린트 공백 누수 방지).
     * 스칼라 루트(예: {@code <amount>100</amount>})는 루트 요소명으로 키잉해 선언 출력이 바로 풀리게 한다.
     * 실패 시 본문을 body 로 보존한다.
     */
    private Object parseXml(String body) {
        if (body == null || body.isBlank()) {
            return Map.of("body", body == null ? "" : body);
        }
        try {
            DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
            // 외부 엔티티/DOCTYPE 차단(파싱 안정성)
            dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            dbf.setExpandEntityReferences(false);
            DocumentBuilder db = dbf.newDocumentBuilder();
            Document doc = db.parse(new InputSource(new StringReader(body)));
            Element root = doc.getDocumentElement();
            if (root == null) {
                return Map.of("body", body);
            }
            Object value = xmlValue(root);
            if (value instanceof Map) {
                return value; // 루트에 자식 요소가 있으면 {자식명: …}
            }
            Map<String, Object> out = new LinkedHashMap<>(); // 스칼라 루트는 루트 요소명으로 키잉
            out.put(root.getNodeName(), value);
            return out;
        } catch (Exception e) {
            return Map.of("body", body); // 파싱 실패 → 통째 보존
        }
    }

    /** XML 요소 → 값. 자식 요소가 있으면 맵(중복은 리스트), 없으면 잎 텍스트(trim). */
    private Object xmlValue(Element el) {
        List<Element> childEls = new ArrayList<>();
        NodeList ch = el.getChildNodes();
        for (int i = 0; i < ch.getLength(); i++) {
            org.w3c.dom.Node n = ch.item(i);
            if (n.getNodeType() == org.w3c.dom.Node.ELEMENT_NODE) {
                childEls.add((Element) n);
            }
        }
        if (childEls.isEmpty()) {
            return el.getTextContent().trim();
        }
        Map<String, Object> m = new LinkedHashMap<>();
        for (Element c : childEls) {
            putMulti(m, c.getNodeName(), xmlValue(c));
        }
        return m;
    }

    @SuppressWarnings("unchecked")
    private static void putMulti(Map<String, Object> map, String key, Object value) {
        Object existing = map.get(key);
        if (existing == null) {
            map.put(key, value);
        } else if (existing instanceof List) {
            ((List<Object>) existing).add(value);
        } else {
            List<Object> list = new ArrayList<>();
            list.add(existing);
            list.add(value);
            map.put(key, list);
        }
    }

    private static String dec(String s, Charset cs) {
        try {
            return URLDecoder.decode(s, cs);
        } catch (Exception e) {
            return s;
        }
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

    /**
     * JSON 바디 값의 타입 코어션. string/미지정은 기존 동작(네이티브) 유지(무회귀).
     * number/boolean/json/null 은 해석해 따옴표 없는 JSON 값으로. 해석 실패 시 원값 보존.
     */
    private Object coerceJson(Object v, String type) {
        if (type == null || type.isBlank() || "string".equals(type)) {
            return v;
        }
        String s = tokens.stringify(v);
        return switch (type) {
            case "number" -> {
                String t = s.trim();
                try {
                    // 분리된 yield 로 Long/Double 타입을 각각 보존(삼항연산자는 double 로 승격시켜 30→30.0 이 됨)
                    if (t.contains(".") || t.contains("e") || t.contains("E")) {
                        yield Double.parseDouble(t);
                    }
                    yield Long.parseLong(t);
                } catch (NumberFormatException e) {
                    yield v;
                }
            }
            case "boolean" -> {
                String t = s.trim();
                if ("true".equalsIgnoreCase(t)) {
                    yield Boolean.TRUE;
                }
                yield "false".equalsIgnoreCase(t) ? Boolean.FALSE : v;
            }
            case "json", "object", "array" -> {
                try {
                    yield json.mapper().readValue(s, Object.class);
                } catch (Exception e) {
                    yield v;
                }
            }
            case "null" -> null;
            default -> v;
        };
    }

    private static String enc(String s, Charset cs) {
        return URLEncoder.encode(s == null ? "" : s, cs);
    }

    /** 노드 문자셋 이름을 Charset 으로(미지정/미지원이면 UTF-8). EUC-KR/MS949/US-ASCII 등 지원. */
    private static Charset charsetOf(String name) {
        if (name == null || name.isBlank()) {
            return StandardCharsets.UTF_8;
        }
        try {
            return Charset.forName(name.trim());
        } catch (Exception e) {
            return StandardCharsets.UTF_8;
        }
    }

    /**
     * Content-Type 헤더에 쓸 charset 라벨. JVM 정규명이 비표준(x-)인 경우 IANA 등록명으로 보정한다.
     * 예: MS949 의 JVM 정규명은 {@code x-windows-949} 이지만, 비JVM 레거시(IIS/.NET/PHP)는
     * IANA 등록명 {@code windows-949} 만 인식한다. (바이트 인코딩 자체는 동일 Charset 이므로 영향 없음)
     */
    private static String wireCharset(Charset cs) {
        String n = cs.name();
        return n.equalsIgnoreCase("x-windows-949") ? "windows-949" : n;
    }

    private record RawResponse(int status, String text, boolean truncated, int byteLength) {
    }

    /** 전송 전 조립된 HTTP 요청. client 모드에서 브라우저로 넘기는 페이로드의 원천이기도 하다. */
    public record BuiltRequest(
            String method,
            String url,
            Map<String, String> headers,
            String body,
            String requestText,
            Map<String, Object> reqValues
    ) {
    }
}
