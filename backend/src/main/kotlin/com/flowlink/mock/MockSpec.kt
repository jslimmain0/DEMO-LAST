package com.flowlink.mock

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * mock 서버의 정의(spec_json) — 사용자 정의 라우트 목록. 프론트 편집기와 1:1 대응.
 * 모든 record 는 ignoreUnknown — 프론트가 편의 필드를 붙여도 파싱이 깨지지 않는다.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class MockSpec(
    val routes: List<MockRoute>?,
    /** TCP mock(고정길이 전문) — 있으면 백엔드가 지정 포트에 TCP 리스너를 연다(프로토콜 참조). */
    val tcp: MockTcp? = null,
    /**
     * 전문 코덱(서버 전체) — 요청 전문이 매칭·템플릿에 들어가기 **전**(request) / 응답 전문을 다 만든 뒤 나가기 **전**(response)
     * 변환 플러그인(FlowTransform)을 순서대로 적용. HTTP 본문·TCP 전문 모두 대상. 라우트의 codec 이 있으면 그것이 우선.
     */
    val codec: MockCodec? = null,
    /**
     * 시크릿 스코프 — 이 Mock 이 `{{ 이름@secret }}` 를 풀 때 쓰는 시크릿 환경 이름(dev/staging/prod).
     * 없으면 공통 시크릿만. 서빙은 서버에서 도니 브라우저 활성 환경과 무관(Mock 별 설정). 환경 변수({{키@env}})는 Mock 에 없음(사용자 결정).
     */
    val environment: String? = null
) {
    fun routesOrEmpty(): List<MockRoute> = routes ?: emptyList()

    /** TCP mock — 프로토콜(필드 스키마)을 참조하는 리스너. 규칙은 위에서부터 첫 매칭(when 비면 전부). */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockTcp(
        val port: Int?,                 // 1024~65535
        val protocolId: String?,        // flowlink_protocol id — 없으면 리스너를 열지 않는다
        val upstream: String? = null,   // "host:port" — proxy 규칙의 실서버
        val timeoutMs: Int? = null,     // upstream 연결/응답 타임아웃(기본 5000)
        val rules: List<MockTcpRule>? = null,
    ) { fun rulesOrEmpty(): List<MockTcpRule> = rules ?: emptyList() }

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockTcpRule(val id: String?, val `when`: List<MockTcpCond>? = null, val then: MockTcpThen? = null, val fault: MockTcpFault? = null) {
        fun whenOrEmpty(): List<MockTcpCond> = `when` ?: emptyList()
        fun isProxy(): Boolean = then?.mode.equals("proxy", ignoreCase = true)
        fun thenFields(): Map<String, String> = then?.fields ?: emptyMap()
    }

    /** then — mode=mock 이면 fields(응답 필드 템플릿, discriminator 값이 응답 표를 고름) / mode=proxy 면 upstream 통과. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockTcpThen(val mode: String? = null, val fields: Map<String, String>? = null)

    /** 요청 필드 조건 — field(헤더/본문 필드명) op(eq|ne|contains|startswith|endswith|regex|exists) value. 비교 전 trim. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockTcpCond(val field: String?, val op: String?, val value: String?)

    /** 장애 주입 — mock·proxy 응답 공통. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockTcpFault(val delayMs: Int? = null, val splitAt: Int? = null, val drop: Boolean? = null, val reset: Boolean? = null, val corruptLength: Boolean? = null)

    /**
     * 전문 코덱 — request/response 각각 플러그인 단계 목록(순서대로 체인). null/빈 목록 = 미적용.
     * 서버(spec.codec)와 라우트(route.codec) 중 라우트 것이 있으면 통째로 라우트 것을 쓴다(필드별 병합 아님).
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockCodec(
        val request: List<MockCodecStep>? = null,
        val response: List<MockCodecStep>? = null
    )

    /**
     * 코덱 단계 — 변환 플러그인 id + 적용 범위 + 입력 포트별 값 + 설정.
     *  - target: body(전문 전체, 기본) | fields(지정 필드만 — HTTP JSON 점 경로/urlencoded 키, TCP 레이아웃/응답 필드명) | header(HTTP 헤더)
     *  - inputs: 플러그인 입력 포트마다 {key, mode: message(전문/대상 값) | value(템플릿 값 — {{ key@secret }} 등)}. 없으면 첫 포트=message.
     *  - config: 파라미터(값은 템플릿 허용). inputKey/outputKey 는 v1 호환(inputKey 포트 = message).
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockCodecStep(
        val id: String?,
        val config: List<KV>? = null,
        val inputKey: String? = null,
        val outputKey: String? = null,
        val target: String? = null,
        val fields: List<String>? = null,
        val header: String? = null,
        val inputs: List<MockCodecInput>? = null
    ) {
        fun targetOrBody(): String = target?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: "body"
        fun fieldsOrEmpty(): List<String> = fields?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
    }

    /** 코덱 단계 입력 포트 값 — mode=message 면 대상 전문/값, value 면 템플릿. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockCodecInput(
        val key: String?,
        val mode: String? = null,
        val value: String? = null
    )

    /**
     * 라우트 하나 — method+경로 패턴(/users/{id})과 규칙 목록. codec 이 있으면 서버 codec 대신 적용.
     * [expect] = 이 라우트로 올 것으로 예상하는 요청 필드(본문/쿼리/헤더) — 데이터 삽입 피커 소스·조건 키 후보·테스트 샘플 요청.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockRoute(
        val id: String?,
        val method: String?, // GET/POST/…/ANY
        val path: String?,
        val rules: List<MockRule>?,
        val codec: MockCodec? = null,
        val expect: MockExpect? = null
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

    /** 예상 요청 정의 — 어떤 요청이 올지 미리 적어 두는 것(요청 기록에서 자동 채움). 실행 의미 없음(편집기·테스트·AI 컨텍스트). */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockExpect(
        val body: List<MockExpectField>? = null,
        val query: List<MockExpectField>? = null,
        val header: List<MockExpectField>? = null
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockExpectField(
        val key: String?,
        val type: String? = null,
        val example: String? = null
    )

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
