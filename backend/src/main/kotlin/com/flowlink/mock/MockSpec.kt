package com.flowlink.mock

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * mock 서버의 정의(spec_json) — 사용자 정의 라우트 목록. 프론트 편집기와 1:1 대응.
 * 모든 record 는 ignoreUnknown — 프론트가 편의 필드를 붙여도 파싱이 깨지지 않는다.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class MockSpec(
    val routes: List<MockRoute>?
) {
    fun routesOrEmpty(): List<MockRoute> = routes ?: emptyList()

    /** 라우트 하나 — method+경로 패턴(/users/{id})과 규칙 목록. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockRoute(
        val id: String?,
        val method: String?, // GET/POST/…/ANY
        val path: String?,
        val rules: List<MockRule>?
    ) {
        fun rulesOrEmpty(): List<MockRule> = rules ?: emptyList()
    }

    /**
     * 응답 규칙 — when 조건(AND)을 모두 만족하는 첫 규칙이 선택된다. when 이 없으면 항상 매칭(기본 규칙).
     * body/headers/callback url·body 는 템플릿({{query.x}}·{{body.x}}·{{uuid}} 등) 지원.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockRule(
        val id: String?,
        val `when`: List<MockCond>?,
        val status: Int?,
        val contentType: String?, // json|text|html|xml 축약 또는 mime 전체
        val charset: String?,     // UTF-8(기본)|EUC-KR|MS949
        val headers: List<KV>?,
        val body: String?,
        val delayMs: Int?,        // cap 10초
        val callback: MockCallback?
    ) {
        fun whenOrEmpty(): List<MockCond> = `when` ?: emptyList()
    }

    /** 조건 — 요청의 query/header/body/path 값 비교. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockCond(
        val source: String?,
        val key: String?,
        val op: String?,
        val value: String?
    )

    /** 응답 후 웹훅 발사(승인노티/입금노티 패턴). url 이 비면 미발사. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockCallback(
        val afterMs: Int?,        // cap 60초
        val url: String?,         // 템플릿 — 예: {{body.notiUrl}}
        val method: String?,      // 기본 POST
        val contentType: String?, // 기본 urlencoded
        val body: String?,        // 템플릿
        val retryUntilOk: Boolean? // true 면 응답이 "OK" 아닐 때 2초 간격 최대 3회 재발송
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class KV(
        val key: String?,
        val value: String?
    )
}
