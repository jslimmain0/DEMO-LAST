package com.flowlink.mock;

import com.flowlink.mock.MockHttp.FiredCallback;
import com.flowlink.mock.MockHttp.MockRequest;
import com.flowlink.mock.MockHttp.MockResponse;
import com.flowlink.mock.MockSpec.MockCond;
import com.flowlink.mock.MockSpec.MockRoute;
import com.flowlink.mock.MockSpec.MockRule;
import org.springframework.stereotype.Component;

import java.nio.charset.Charset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * CUSTOM mock 서버의 순수 런타임 — 라우트 매칭·조건 평가·템플릿 렌더.
 * 상태가 없어 단위 테스트 대상. (콜백 "발사"는 {@link MockCallbackDispatcher}가 담당)
 *
 * <p>템플릿 토큰(응답 body·헤더 값·콜백 url/body):
 * {@code {{path.x}} {{query.x}} {{header.x}} {{body.x}} {{body}} {{method}} {{uuid}} {{seq}} {{now}}}
 * — 미해석 토큰은 빈 문자열. (워크플로 바인딩 {@code {{ key@node }}} 와는 다른 문맥)
 */
@Component
public class MockRuntime {

    private static final Pattern TOKEN = Pattern.compile("\\{\\{\\s*(.+?)\\s*}}");
    public static final int MAX_DELAY_MS = 10_000;
    public static final int MAX_CALLBACK_DELAY_MS = 60_000;

    /** 매칭 결과 — 규칙·경로 파라미터. */
    public record Match(MockRule rule, Map<String, String> pathParams) {
    }

    /** 정의 순서대로 method+경로 첫 매칭 라우트, 그 안에서 조건 만족 첫 규칙. */
    public Optional<Match> match(List<MockRoute> routes, MockRequest req) {
        for (MockRoute route : routes) {
            Map<String, String> params = matchPath(route.path(), req.path());
            if (params == null) {
                continue;
            }
            String m = route.method() == null ? "ANY" : route.method().toUpperCase(Locale.ROOT);
            if (!m.equals("ANY") && !m.equals(req.method())) {
                continue;
            }
            for (MockRule rule : route.rulesOrEmpty()) {
                if (conditionsPass(rule.whenOrEmpty(), req, params)) {
                    return Optional.of(new Match(rule, params));
                }
            }
            // 경로는 맞지만 규칙 무매칭 — 다음 라우트로 넘기지 않고 404 (같은 경로 중복 정의 혼란 방지)
            return Optional.empty();
        }
        return Optional.empty();
    }

    /** 규칙 → 실제 응답(바이트) + 지연 + 콜백 명세. seq 는 서버별 증가 카운터 공급자에서 받은 값. */
    public MockResponse render(MockRule rule, MockRequest req, Map<String, String> pathParams, long seq) {
        Charset cs = MockHttp.charsetOf(rule.charset());
        String body = template(rule.body() == null ? "" : rule.body(), req, pathParams, seq);
        Map<String, String> headers = new LinkedHashMap<>();
        for (MockSpec.KV kv : rule.headers() == null ? List.<MockSpec.KV>of() : rule.headers()) {
            if (kv.key() != null && !kv.key().isBlank()) {
                headers.put(kv.key(), template(kv.value() == null ? "" : kv.value(), req, pathParams, seq));
            }
        }
        int delay = rule.delayMs() == null ? 0 : Math.max(0, Math.min(rule.delayMs(), MAX_DELAY_MS));
        FiredCallback cb = null;
        MockSpec.MockCallback c = rule.callback();
        if (c != null) {
            String url = template(c.url() == null ? "" : c.url(), req, pathParams, seq).trim();
            if (!url.isEmpty()) {
                cb = new FiredCallback(
                        c.afterMs() == null ? 0 : Math.max(0, Math.min(c.afterMs(), MAX_CALLBACK_DELAY_MS)),
                        url,
                        c.method() == null || c.method().isBlank() ? "POST" : c.method().toUpperCase(Locale.ROOT),
                        MockHttp.contentTypeHeader(
                                c.contentType() == null || c.contentType().isBlank() ? "urlencoded" : c.contentType(),
                                java.nio.charset.StandardCharsets.UTF_8),
                        template(c.body() == null ? "" : c.body(), req, pathParams, seq),
                        Boolean.TRUE.equals(c.retryUntilOk()));
            }
        }
        int status = rule.status() == null ? 200 : rule.status();
        return new MockResponse(status, MockHttp.contentTypeHeader(rule.contentType(), cs), headers,
                body.getBytes(cs), delay, cb);
    }

    // ---------- 경로 매칭 ----------

    /** /users/{id} 패턴 매칭. 매칭되면 경로 파라미터 맵(빈 맵 가능), 아니면 null. */
    static Map<String, String> matchPath(String pattern, String actual) {
        if (pattern == null || pattern.isBlank()) {
            return null;
        }
        String[] ps = normalize(pattern).split("/");
        String[] as = normalize(actual).split("/");
        if (ps.length != as.length) {
            return null;
        }
        Map<String, String> params = new LinkedHashMap<>();
        for (int i = 0; i < ps.length; i++) {
            String p = ps[i];
            if (p.length() >= 2 && p.startsWith("{") && p.endsWith("}")) {
                if (as[i].isEmpty()) {
                    return null;
                }
                params.put(p.substring(1, p.length() - 1), as[i]);
            } else if (!p.equals(as[i])) {
                return null;
            }
        }
        return params;
    }

    private static String normalize(String path) {
        String p = path == null ? "" : path.trim();
        if (!p.startsWith("/")) {
            p = "/" + p;
        }
        if (p.length() > 1 && p.endsWith("/")) {
            p = p.substring(0, p.length() - 1);
        }
        return p;
    }

    // ---------- 조건 ----------

    static boolean conditionsPass(List<MockCond> conds, MockRequest req, Map<String, String> pathParams) {
        for (MockCond c : conds) {
            String actual = valueOf(c.source(), c.key(), req, pathParams);
            String op = c.op() == null ? "eq" : c.op().toLowerCase(Locale.ROOT);
            boolean pass = switch (op) {
                case "eq" -> actual != null && actual.equals(c.value() == null ? "" : c.value());
                case "ne" -> actual == null || !actual.equals(c.value() == null ? "" : c.value());
                case "exists" -> actual != null && !actual.isEmpty();
                case "contains" -> actual != null && actual.contains(c.value() == null ? "" : c.value());
                default -> false;
            };
            if (!pass) {
                return false;
            }
        }
        return true;
    }

    private static String valueOf(String source, String key, MockRequest req, Map<String, String> pathParams) {
        if (key == null) {
            return null;
        }
        String src = source == null ? "" : source.toLowerCase(Locale.ROOT);
        return switch (src) {
            case "query" -> req.query().get(key);
            case "header" -> req.headers().get(key.toLowerCase(Locale.ROOT));
            case "body" -> req.bodyFields().get(key);
            case "path" -> pathParams.get(key);
            default -> null;
        };
    }

    // ---------- 템플릿 ----------

    String template(String text, MockRequest req, Map<String, String> pathParams, long seq) {
        if (text == null || text.isEmpty() || !text.contains("{{")) {
            return text == null ? "" : text;
        }
        Matcher m = TOKEN.matcher(text);
        StringBuilder sb = new StringBuilder();
        while (m.find()) {
            m.appendReplacement(sb, Matcher.quoteReplacement(resolve(m.group(1), req, pathParams, seq)));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    private String resolve(String token, MockRequest req, Map<String, String> pathParams, long seq) {
        String t = token.trim();
        String v = switch (t) {
            case "uuid" -> UUID.randomUUID().toString();
            case "seq" -> String.valueOf(seq);
            case "now" -> java.time.Instant.now().toString();
            case "method" -> req.method();
            case "body" -> req.bodyText() == null ? "" : req.bodyText();
            default -> null;
        };
        if (v != null) {
            return v;
        }
        int dot = t.indexOf('.');
        if (dot > 0 && dot < t.length() - 1) {
            String src = t.substring(0, dot);
            String key = t.substring(dot + 1);
            String got = valueOf(src, key, req, pathParams);
            return got == null ? "" : got;
        }
        return ""; // 미해석 토큰 — 빈 문자열
    }
}
