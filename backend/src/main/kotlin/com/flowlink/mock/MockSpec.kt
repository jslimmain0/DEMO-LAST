package com.flowlink.mock

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * mock 서버의 정의(spec_json) — 사용자 정의 라우트 목록. 프론트 편집기와 1:1 대응.
 * 모든 record 는 ignoreUnknown — 프론트가 편의 필드를 붙여도 파싱이 깨지지 않는다.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class MockSpec(
    val routes: List<MockRoute>?,
    /** TCP mock(고정길이 전문) — 있으면 백엔드가 지정 포트에 TCP 리스너를 연다. */
    val tcp: MockTcp? = null
) {
    fun routesOrEmpty(): List<MockRoute> = routes ?: emptyList()

    /**
     * TCP mock 정의 — 길이 프리픽스(기본 4바이트 ASCII, 자기 미포함) 전문을 받아
     * 규칙(contains 매칭) 첫 일치의 응답 템플릿을 같은 규약으로 돌려준다.
     * 템플릿: {{req}} = 요청 전문 전체, {{req:오프셋:길이}} = 바이트 슬라이스(디코딩 후 삽입).
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockTcp(
        val enabled: Boolean?,           // 기본 true(서버 enabled 와 AND)
        val port: Int?,                  // 1024~65535
        val charset: String?,            // 기본 EUC-KR(금융 전문 관례)
        val prefixLength: Int?,          // 기본 4. 0 = 프리픽스 없음(연결당 1전문, EOF 까지 읽음)
        val prefixIncludesSelf: Boolean?,
        val rules: List<MockTcpRule>?
    ) {
        fun rulesOrEmpty(): List<MockTcpRule> = rules ?: emptyList()
    }

    /** TCP 규칙 — 디코딩된 요청 전문에 contains 가 포함되면 매칭(비면 항상 = 기본 규칙). */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockTcpRule(
        val id: String?,
        val contains: String?,
        val response: String?
    )

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
        val callback: MockCallback?,
        // 상태 있는 목: 응답 후 서버(slug)별 상태를 설정(값은 템플릿). 조건/템플릿에서 {{state.KEY}}·source=state 로 읽는다.
        // 예: 1차 호출이 setState status=approved → 2차 호출 when source=state key=status value=approved 로 다른 응답.
        val setState: List<MockSetOp>? = null,
        // 순차 응답: 이 규칙을 처음 N회 매칭까지만 적용하고 이후엔 다음 매칭 규칙으로 폴스루(id 필요).
        // 예: A(repeat=1) pending → B(기본) approved → 1차 A, 이후 B.
        val repeat: Int? = null
    ) {
        fun whenOrEmpty(): List<MockCond> = `when` ?: emptyList()
    }

    /** 상태 설정 항목 — op: set(기본,대입) | incr(증가) | decr(감소). incr/decr 은 숫자 누산기. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockSetOp(
        val key: String?,
        val value: String?,
        val op: String? = null
    )

    /** 조건 — 요청의 query/header/body/path/state 값 비교. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockCond(
        val source: String?,
        val key: String?,
        val op: String?,       // eq|ne|exists|contains|gt|gte|lt|lte|regex|startswith|endswith
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
