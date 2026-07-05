package com.flowlink.mock

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * mock 서버의 정의(spec_json) — 사용자 정의 라우트 목록. 프론트 편집기와 1:1 대응.
 * 모든 record 는 ignoreUnknown — 프론트가 편의 필드를 붙여도 파싱이 깨지지 않는다.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class MockSpec(
    @get:JvmName("routes")
    val routes: List<MockRoute>?
) {
    fun routesOrEmpty(): List<MockRoute> = routes ?: emptyList()

    /** 라우트 하나 — method+경로 패턴(/users/{id})과 규칙 목록. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockRoute(
        @get:JvmName("id")
        val id: String?,
        @get:JvmName("method")
        val method: String?, // GET/POST/…/ANY
        @get:JvmName("path")
        val path: String?,
        @get:JvmName("rules")
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
        @get:JvmName("id")
        val id: String?,
        val `when`: List<MockCond>?,
        @get:JvmName("status")
        val status: Int?,
        @get:JvmName("contentType")
        val contentType: String?, // json|text|html|xml 축약 또는 mime 전체
        @get:JvmName("charset")
        val charset: String?,     // UTF-8(기본)|EUC-KR|MS949
        @get:JvmName("headers")
        val headers: List<KV>?,
        @get:JvmName("body")
        val body: String?,
        @get:JvmName("delayMs")
        val delayMs: Int?,        // cap 10초
        @get:JvmName("callback")
        val callback: MockCallback?
    ) {
        fun whenOrEmpty(): List<MockCond> = `when` ?: emptyList()
    }

    /** 조건 — 요청의 query/header/body/path 값 비교. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockCond(
        @get:JvmName("source")
        val source: String?,
        @get:JvmName("key")
        val key: String?,
        @get:JvmName("op")
        val op: String?,
        @get:JvmName("value")
        val value: String?
    )

    /** 응답 후 웹훅 발사(승인노티/입금노티 패턴). url 이 비면 미발사. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockCallback(
        @get:JvmName("afterMs")
        val afterMs: Int?,        // cap 60초
        @get:JvmName("url")
        val url: String?,         // 템플릿 — 예: {{body.notiUrl}}
        @get:JvmName("method")
        val method: String?,      // 기본 POST
        @get:JvmName("contentType")
        val contentType: String?, // 기본 urlencoded
        @get:JvmName("body")
        val body: String?,        // 템플릿
        @get:JvmName("retryUntilOk")
        val retryUntilOk: Boolean? // true 면 응답이 "OK" 아닐 때 2초 간격 최대 3회 재발송
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class KV(
        @get:JvmName("key")
        val key: String?,
        @get:JvmName("value")
        val value: String?
    )
}
