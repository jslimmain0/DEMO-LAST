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

    // ---------- URL 경로/헤더 디코딩 (게이트웨이 공용) ----------

    /**
     * Content-Type 헤더의 {@code charset=} 를 Charset 으로. 없으면 UTF-8.
     * 레거시 별칭 보정({@code windows-949}→JVM 정규명 {@code x-windows-949})은 {@link #wireCharset}의 역방향.
     */
    public static Charset charsetFromContentType(String contentType) {
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
        if (name.equalsIgnoreCase("windows-949")) {
            name = "x-windows-949";
        }
        return charsetOf(name);
    }

    /**
     * URL 경로를 세그먼트별로 percent-디코딩한다. URLDecoder 와 달리 {@code '+'}는 리터럴로 둔다
     * (URL 경로에서 {@code '+'}는 리터럴, 공백은 {@code %20} — form 디코더를 경로에 쓰면 경로 파라미터가 오염된다).
     * 인코딩된 슬래시({@code %2F})는 세그먼트 내부 값으로 보존.
     */
    public static String decodePath(String rawPath) {
        if (rawPath == null || rawPath.isEmpty()) {
            return "/";
        }
        String[] segs = rawPath.split("/", -1);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < segs.length; i++) {
            if (i > 0) {
                sb.append('/');
            }
            sb.append(percentDecodeKeepPlus(segs[i]));
        }
        return sb.toString();
    }

    /** %XX 를 UTF-8 바이트로 디코딩하되 {@code '+'}와 그 외 문자는 그대로 둔다(URLDecoder 와 달리 {@code '+'}≠공백). */
    private static String percentDecodeKeepPlus(String s) {
        if (s.indexOf('%') < 0) {
            return s;
        }
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%' && i + 2 < s.length()) {
                int hi = Character.digit(s.charAt(i + 1), 16);
                int lo = Character.digit(s.charAt(i + 2), 16);
                if (hi >= 0 && lo >= 0) {
                    buf.write((hi << 4) + lo);
                    i += 2;
                    continue;
                }
            }
            byte[] cb = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
            buf.write(cb, 0, cb.length);
        }
        return new String(buf.toByteArray(), StandardCharsets.UTF_8);
    }
}
