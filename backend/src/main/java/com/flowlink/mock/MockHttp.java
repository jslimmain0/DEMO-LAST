package com.flowlink.mock;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** mock 서빙 공용 타입/유틸 — 게이트웨이가 파싱한 요청과 렌더된 응답. */
public final class MockHttp {

    private MockHttp() {
    }

    /**
     * 게이트웨이가 파싱한 요청. path 는 slug 제거 후(항상 / 시작), header 키는 소문자,
     * bodyFields 는 JSON 최상위 키(값은 문자열화) 또는 urlencoded 필드.
     */
    public record MockRequest(
            String method,
            String path,
            Map<String, String> query,
            Map<String, String> headers,
            String bodyText,
            Map<String, String> bodyFields
    ) {
        public String header(String name) {
            return headers == null ? null : headers.get(name.toLowerCase(Locale.ROOT));
        }
    }

    /** 서빙할 응답(바이트 확정) + 선택적 지연·콜백 발사 명세. */
    public record MockResponse(
            int status,
            String contentType, // 완성된 Content-Type 헤더 값
            Map<String, String> headers,
            byte[] body,
            int delayMs,
            FiredCallback callback
    ) {
        public static MockResponse of(int status, String contentType, byte[] body) {
            return new MockResponse(status, contentType, Map.of(), body, 0, null);
        }
    }

    /** 템플릿 해석이 끝난 콜백 발사 명세. */
    public record FiredCallback(int afterMs, String url, String method, String contentType, String body,
                                boolean retryUntilOk) {
    }

    // ---------- charset ----------

    public static Charset charsetOf(String name) {
        if (name == null || name.isBlank()) {
            return StandardCharsets.UTF_8;
        }
        try {
            return Charset.forName(name);
        } catch (Exception e) {
            return StandardCharsets.UTF_8;
        }
    }

    /** Content-Type 에 쓸 IANA 이름(HttpNodeExecutor.wireCharset 과 동일 보정 — MS949 → windows-949). */
    public static String wireCharset(Charset cs) {
        String n = cs.name();
        return n.equalsIgnoreCase("x-windows-949") ? "windows-949" : n;
    }

    /** 축약(json/text/html/xml) 또는 mime → 완성된 Content-Type 헤더 값. */
    public static String contentTypeHeader(String shorthand, Charset cs) {
        String t = shorthand == null || shorthand.isBlank() ? "json" : shorthand.toLowerCase(Locale.ROOT);
        String mime = switch (t) {
            case "json" -> "application/json";
            case "text" -> "text/plain";
            case "html" -> "text/html";
            case "xml" -> "application/xml";
            case "urlencoded", "form" -> "application/x-www-form-urlencoded";
            default -> t.contains("/") ? t : "text/plain";
        };
        return mime.contains("charset") ? mime : mime + "; charset=" + wireCharset(cs);
    }

    // ---------- urlencoded ----------

    /** a=1&b=2 → 맵(첫 값 우선). 퍼센트 디코딩은 cs 문자셋. */
    public static Map<String, String> parseUrlEncoded(String text, Charset cs) {
        Map<String, String> out = new LinkedHashMap<>();
        if (text == null || text.isBlank()) {
            return out;
        }
        for (String pair : text.split("&")) {
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String k = urlDecode(eq >= 0 ? pair.substring(0, eq) : pair, cs);
            String v = eq >= 0 ? urlDecode(pair.substring(eq + 1), cs) : "";
            out.putIfAbsent(k, v);
        }
        return out;
    }

    public static String urlDecode(String s, Charset cs) {
        try {
            return java.net.URLDecoder.decode(s, cs);
        } catch (Exception e) {
            return s;
        }
    }

    public static String urlEncode(String s, Charset cs) {
        try {
            return java.net.URLEncoder.encode(s == null ? "" : s, cs);
        } catch (Exception e) {
            return s == null ? "" : s;
        }
    }

    /** 키-값들을 urlencoded 본문으로(UTF-8). */
    public static String toUrlEncoded(List<Map.Entry<String, String>> pairs) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : pairs) {
            if (sb.length() > 0) {
                sb.append('&');
            }
            sb.append(urlEncode(e.getKey(), StandardCharsets.UTF_8))
                    .append('=')
                    .append(urlEncode(e.getValue(), StandardCharsets.UTF_8));
        }
        return sb.toString();
    }

    public static String escapeHtml(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&' -> sb.append("&amp;");
                case '<' -> sb.append("&lt;");
                case '>' -> sb.append("&gt;");
                case '"' -> sb.append("&quot;");
                case '\'' -> sb.append("&#39;");
                default -> sb.append(c);
            }
        }
        return sb.toString();
    }
}
