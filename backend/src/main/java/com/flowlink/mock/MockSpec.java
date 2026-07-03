package com.flowlink.mock;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

/**
 * CUSTOM mock 서버의 정의(spec_json). 프론트 편집기와 1:1 대응.
 * 모든 record 는 ignoreUnknown — 프론트가 편의 필드를 붙여도 파싱이 깨지지 않는다.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record MockSpec(
        List<MockRoute> routes,
        String secret // PG 프리셋 전용(서명 검증 키). CUSTOM 에선 무시.
) {
    public List<MockRoute> routesOrEmpty() {
        return routes == null ? List.of() : routes;
    }

    /** 라우트 하나 — method+경로 패턴(/users/{id})과 규칙 목록. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record MockRoute(
            String id,
            String method, // GET/POST/…/ANY
            String path,
            List<MockRule> rules
    ) {
        public List<MockRule> rulesOrEmpty() {
            return rules == null ? List.of() : rules;
        }
    }

    /**
     * 응답 규칙 — when 조건(AND)을 모두 만족하는 첫 규칙이 선택된다. when 이 없으면 항상 매칭(기본 규칙).
     * body/headers/callback url·body 는 템플릿({{query.x}}·{{body.x}}·{{uuid}} 등) 지원.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record MockRule(
            String id,
            List<MockCond> when,
            Integer status,
            String contentType, // json|text|html|xml 축약 또는 mime 전체
            String charset,     // UTF-8(기본)|EUC-KR|MS949
            List<KV> headers,
            String body,
            Integer delayMs,    // cap 10초
            MockCallback callback
    ) {
        public List<MockCond> whenOrEmpty() {
            return when == null ? List.of() : when;
        }
    }

    /** 조건 — 요청의 query/header/body/path 값 비교. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record MockCond(String source, String key, String op, String value) {
    }

    /** 응답 후 웹훅 발사(승인노티/입금노티 패턴). url 이 비면 미발사. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record MockCallback(
            Integer afterMs,    // cap 60초
            String url,         // 템플릿 — 예: {{body.notiUrl}}
            String method,      // 기본 POST
            String contentType, // 기본 urlencoded
            String body,        // 템플릿
            Boolean retryUntilOk // true 면 응답이 "OK" 아닐 때 2초 간격 최대 3회 재발송
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record KV(String key, String value) {
    }
}
