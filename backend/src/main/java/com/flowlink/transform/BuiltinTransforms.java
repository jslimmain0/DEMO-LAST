package com.flowlink.transform;

import com.flowlink.transform.FlowTransform.IoSpec;
import com.flowlink.transform.FlowTransform.TransformParam;

import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 내장 변환 모음(샌드박스 불필요한 순수 문자열 변환). */
public final class BuiltinTransforms {

    private BuiltinTransforms() {
    }

    public static List<FlowTransform> all() {
        return List.of(
                t("split", "구분자로 분리 후 인덱스",
                        List.of(TransformParam.of("delimiter", "구분자", ","), TransformParam.of("index", "인덱스", "0")),
                        (in, c) -> {
                            String[] parts = s(in).split(Pattern.quote(c.getOrDefault("delimiter", ",")), -1);
                            int i = intOf(c.get("index"), 0);
                            return (i >= 0 && i < parts.length) ? parts[i] : "";
                        }),
                t("substring", "부분 문자열",
                        List.of(TransformParam.of("start", "시작", "0"), TransformParam.of("end", "끝(빈값=끝까지)", "")),
                        (in, c) -> {
                            String s = s(in);
                            int start = clamp(intOf(c.get("start"), 0), 0, s.length());
                            int end = c.getOrDefault("end", "").isBlank() ? s.length() : clamp(intOf(c.get("end"), s.length()), start, s.length());
                            return s.substring(start, end);
                        }),
                t("base64-encode", "Base64 인코딩", List.of(),
                        (in, c) -> Base64.getEncoder().encodeToString(s(in).getBytes(StandardCharsets.UTF_8))),
                t("base64-decode", "Base64 디코딩", List.of(),
                        (in, c) -> {
                            try {
                                return new String(Base64.getDecoder().decode(s(in)), StandardCharsets.UTF_8);
                            } catch (IllegalArgumentException e) {
                                return "";
                            }
                        }),
                t("url-encode", "URL 인코딩", List.of(),
                        (in, c) -> URLEncoder.encode(s(in), StandardCharsets.UTF_8)),
                t("url-decode", "URL 디코딩", List.of(),
                        (in, c) -> URLDecoder.decode(s(in), StandardCharsets.UTF_8)),
                t("upper", "대문자", List.of(), (in, c) -> s(in).toUpperCase(Locale.ROOT)),
                t("lower", "소문자", List.of(), (in, c) -> s(in).toLowerCase(Locale.ROOT)),
                t("trim", "공백 제거", List.of(), (in, c) -> s(in).trim()),
                t("replace", "정규식 치환",
                        List.of(TransformParam.of("pattern", "정규식"), TransformParam.of("replacement", "치환값")),
                        (in, c) -> {
                            try {
                                return s(in).replaceAll(c.getOrDefault("pattern", ""), c.getOrDefault("replacement", ""));
                            } catch (RuntimeException e) {
                                return s(in);
                            }
                        }),
                t("regex-extract", "정규식 추출(그룹)",
                        List.of(TransformParam.of("pattern", "정규식"), TransformParam.of("group", "그룹 번호", "1")),
                        (in, c) -> {
                            try {
                                Matcher m = Pattern.compile(c.getOrDefault("pattern", "")).matcher(s(in));
                                if (m.find()) {
                                    int g = intOf(c.get("group"), 1);
                                    return g <= m.groupCount() ? n(m.group(g)) : "";
                                }
                            } catch (RuntimeException ignored) {
                            }
                            return "";
                        }),
                t("sha256", "SHA-256 해시(hex)", List.of(), (in, c) -> hash("SHA-256", s(in))),
                t("md5", "MD5 해시(hex)", List.of(), (in, c) -> hash("MD5", s(in))),

                // --- 멀티 입출력 예시 ---
                new MultiTransform("concat", "두 값 이어붙이기",
                        List.of(IoSpec.of("a", "값1"), IoSpec.of("b", "값2")),
                        List.of(IoSpec.of("result", "결과")),
                        List.of(),
                        (in, c) -> Map.of("result", s(in.get("a")) + s(in.get("b")))),
                new MultiTransform("pair-split", "구분자로 둘로 분리",
                        List.of(IoSpec.of("value", "입력")),
                        List.of(IoSpec.of("first", "앞"), IoSpec.of("second", "뒤")),
                        List.of(TransformParam.of("delimiter", "구분자", "=")),
                        (in, c) -> {
                            String[] p = s(in.get("value")).split(Pattern.quote(c.getOrDefault("delimiter", "=")), 2);
                            return Map.of("first", p.length > 0 ? p[0] : "", "second", p.length > 1 ? p[1] : "");
                        })
        );
    }

    private static FlowTransform t(String id, String label, List<TransformParam> params,
                                   BiFunction<String, Map<String, String>, String> fn) {
        return new SimpleTransform(id, label, params, fn);
    }

    private static String s(String v) {
        return v == null ? "" : v;
    }

    private static String n(String v) {
        return v == null ? "" : v;
    }

    private static int intOf(String v, int def) {
        if (v == null) {
            return def;
        }
        try {
            return Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(v, hi));
    }

    private static String hash(String algo, String in) {
        try {
            MessageDigest md = MessageDigest.getInstance(algo);
            byte[] digest = md.digest(in.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 단일 입력("input") → 단일 출력("result") 어댑터. */
    private record SimpleTransform(
            String id,
            String label,
            List<TransformParam> params,
            BiFunction<String, Map<String, String>, String> fn
    ) implements FlowTransform {
        @Override
        public Map<String, String> apply(Map<String, String> inputs, Map<String, String> config) {
            String in = inputs == null ? "" : inputs.getOrDefault("input", "");
            String out = fn.apply(in == null ? "" : in, config == null ? Map.of() : config);
            return Map.of("result", out == null ? "" : out);
        }
    }

    /** 멀티 입출력 변환. */
    private record MultiTransform(
            String id,
            String label,
            List<IoSpec> ins,
            List<IoSpec> outs,
            List<TransformParam> params,
            BiFunction<Map<String, String>, Map<String, String>, Map<String, String>> fn
    ) implements FlowTransform {
        @Override
        public List<IoSpec> inputs() {
            return ins;
        }

        @Override
        public List<IoSpec> outputs() {
            return outs;
        }

        @Override
        public Map<String, String> apply(Map<String, String> inputs, Map<String, String> config) {
            return fn.apply(inputs == null ? Map.of() : inputs, config == null ? Map.of() : config);
        }
    }
}
