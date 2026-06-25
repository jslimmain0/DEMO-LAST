package com.flowlink.execution.engine;

import com.flowlink.common.json.JsonService;
import com.flowlink.core.graph.Binding;
import com.flowlink.core.graph.NodeField;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 바인딩/토큰 해석기 — 프로토타입의 ctxResolve/ctxTokens/fieldVal 의미를 서버에서 재현한다.
 *
 * <p>토큰 형태: {@code {{ key }}}(bare, 가장 가까운 상위), {@code {{ key@sourceId }}}(명시),
 * {@code {{ key@req:sourceId }}}(요청값 스코프).
 */
@Component
public class TokenResolver {

    private static final Pattern TOKEN =
            Pattern.compile("\\{\\{\\s*([\\w.-]+)(?:@(req:)?([A-Za-z0-9]+))?\\s*}}");

    private final JsonService json;

    public TokenResolver(JsonService json) {
        this.json = json;
    }

    /** 바인딩 값을 그대로(원형 객체로) 해석. */
    public Object resolveBinding(Binding b, ExecutionContext ctx) {
        if (b == null) {
            return null;
        }
        Object src = ctx.raw((b.isRequestScope() ? "req:" : "") + b.sourceId());
        if (src instanceof List<?> list) {
            src = list.isEmpty() ? null : list.get(0);
        }
        if (src instanceof Map<?, ?> map) {
            return map.get(b.key());
        }
        return null;
    }

    /** 필드 값 — 바인딩이면 그 값, 아니면 {{토큰}} 치환된 리터럴. */
    public Object fieldValue(NodeField f, ExecutionContext ctx) {
        if (f.bound() != null) {
            return resolveBinding(f.bound(), ctx);
        }
        String v = f.value();
        return (v != null && v.contains("{{")) ? resolveTokens(v, ctx) : v;
    }

    /** 문자열 내 {{토큰}}을 모두 치환. 해석 실패 토큰은 빈 문자열로. */
    public String resolveTokens(String str, ExecutionContext ctx) {
        if (str == null || str.isEmpty()) {
            return str == null ? "" : str;
        }
        Matcher m = TOKEN.matcher(str);
        StringBuilder sb = new StringBuilder();
        while (m.find()) {
            String key = m.group(1);
            boolean req = m.group(2) != null;
            String srcId = m.group(3);
            String replacement;
            if (srcId != null) {
                replacement = pickVal(ctx.raw((req ? "req:" : "") + srcId), key);
            } else {
                replacement = nearestUpstream(key, ctx);
            }
            m.appendReplacement(sb, Matcher.quoteReplacement(replacement == null ? "" : replacement));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    /** IF 표현식 평가용 — 토큰을 (문자열이 아닌) 원형 객체로 해석한다. 없거나 null이면 null. */
    public Object resolveTokenObject(String key, boolean req, String srcId, ExecutionContext ctx) {
        if (srcId != null) {
            return pickObject(ctx.raw((req ? "req:" : "") + srcId), key);
        }
        for (String k : ctx.keysReversed()) {
            if (k.startsWith("req:")) {
                continue;
            }
            Object o = pickObject(ctx.raw(k), key);
            if (o != null) {
                return o;
            }
        }
        return null;
    }

    private Object pickObject(Object obj, String key) {
        Object base = (obj instanceof List<?> list) ? (list.isEmpty() ? null : list.get(0)) : obj;
        if (base instanceof Map<?, ?> map && map.containsKey(key)) {
            return map.get(key);
        }
        return null;
    }

    public static Pattern tokenPattern() {
        return TOKEN;
    }

    private String nearestUpstream(String key, ExecutionContext ctx) {
        for (String k : ctx.keysReversed()) {
            if (k.startsWith("req:")) {
                continue;
            }
            String v = pickVal(ctx.raw(k), key);
            if (v != null) {
                return v;
            }
        }
        return null;
    }

    /** 객체(또는 배열의 첫 원소)에서 key 값을 문자열로 추출. */
    public String pickVal(Object obj, String key) {
        Object base = (obj instanceof List<?> list) ? (list.isEmpty() ? null : list.get(0)) : obj;
        if (base instanceof Map<?, ?> map && map.containsKey(key)) {
            return stringify(map.get(key));
        }
        return null;
    }

    /** ctx 값들을 헤더/쿼리/바디에 넣기 위한 문자열화. */
    public String stringify(Object v) {
        if (v == null) {
            return "";
        }
        if (v instanceof String s) {
            return s;
        }
        if (v instanceof Number || v instanceof Boolean) {
            return String.valueOf(v);
        }
        return json.toJson(v); // 객체/배열은 JSON 문자열로
    }
}
