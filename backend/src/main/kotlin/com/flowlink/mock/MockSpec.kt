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
    val tcp: MockTcp? = null,
    /**
     * 전문 코덱(서버 전체) — 요청 전문이 매칭·템플릿에 들어가기 **전**(request) / 응답 전문을 다 만든 뒤 나가기 **전**(response)
     * 변환 플러그인(FlowTransform)을 순서대로 적용. HTTP 본문·TCP 전문 모두 대상. 라우트의 codec 이 있으면 그것이 우선.
     */
    val codec: MockCodec? = null,
    /**
     * 시크릿 스코프 — 이 Mock 이 `{{ 이름@secret }}` 를 풀 때 쓰는 시크릿 환경 이름(dev/staging/prod).
     * 없으면 공통 시크릿(+Vault)만. 서빙은 서버에서 도니 브라우저 활성 환경과 무관(Mock 별 설정). 환경 변수({{키@env}})는 Mock 에 없음(사용자 결정).
     */
    val environment: String? = null
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
        val rules: List<MockTcpRule>?,
        /** 요청 전문 레이아웃 — 앞에서부터 바이트 길이대로 잘라 필드명을 붙인다({{req.이름}}·필드 조건). 없으면 슬라이스 토큰만. */
        val requestFields: List<MockTcpReqField>? = null
    ) {
        fun rulesOrEmpty(): List<MockTcpRule> = rules ?: emptyList()
        fun requestFieldsOrEmpty(): List<MockTcpReqField> = requestFields ?: emptyList()
    }

    /** 요청 전문 필드(레이아웃) — 이름 + 바이트 길이(+필드별 인코딩). 오프셋은 선언 순서로 누적. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockTcpReqField(
        val id: String?,
        val name: String?,
        val length: Int?,
        val encoding: String? = null
    )

    /**
     * TCP 규칙 — [contains](디코딩 전문 포함 문자열) AND [when](요청 필드 조건) 모두 만족하면 매칭(둘 다 비면 기본 규칙).
     * 응답: [responseFields] 가 있으면 필드별 바이트 조립(길이·패딩·인코딩), 없으면 [response] 텍스트 템플릿.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockTcpRule(
        val id: String?,
        val contains: String?,
        val response: String?,
        val `when`: List<MockTcpCond>? = null,
        val responseFields: List<MockTcpRespField>? = null
    ) {
        fun whenOrEmpty(): List<MockTcpCond> = `when` ?: emptyList()
        fun responseFieldsOrEmpty(): List<MockTcpRespField> = responseFields ?: emptyList()
    }

    /** 요청 필드 조건 — field(requestFields 이름) op(eq|ne|contains|startswith|endswith|regex|exists) value. 비교 전 값은 trim. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockTcpCond(
        val field: String?,
        val op: String?,
        val value: String?
    )

    /**
     * 응답 필드 — 값 템플릿({{req.이름}}·{{req}}·{{req:o:l}}·{{seq}}·{{now}}·{{uuid}})을 [length] 바이트 고정길이로.
     * pad=left|right(기본 right), padChar 기본 공백, encoding 은 필드별(없으면 tcp.charset).
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MockTcpRespField(
        val id: String?,
        val name: String?,
        val length: Int?,
        val value: String?,
        val pad: String? = null,
        val padChar: String? = null,
        val encoding: String? = null
    )

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
