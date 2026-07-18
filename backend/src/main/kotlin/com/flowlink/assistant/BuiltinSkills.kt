package com.flowlink.assistant

/**
 * 코드 내장 스킬 — 항상 사용 가능(수정 불가). 흔한 REST/워크플로 패턴을 어시스턴트가 알도록.
 * 사용자 스킬은 설정(JSON)으로 추가·수정하며 이 목록 위에 얹힌다.
 */
object BuiltinSkills {

    val ALL: List<Skill> = listOf(
        Skill(
            name = "OAuth2 인증 (client credentials)",
            description = "M2M API 를 OAuth2 client_credentials 로 인증",
            nodeTypes = listOf("http"),
            builtin = true,
            instruction = """
                외부 API 가 OAuth2 client_credentials 를 요구하면, HTTP 노드의 auth 블록을 쓴다:
                "auth": {"type":"oauth2_cc","tokenUrl":"<token endpoint>","clientId":"<id>","clientSecret":"{{ SECRET_NAME@secret }}","scope":"<선택>","clientAuth":"body"}
                - clientSecret 은 시크릿 볼트 토큰({{ 이름@secret }})을 권장(평문 금지).
                - 백엔드가 실행 직전 토큰을 받아 Authorization: Bearer 로 주입·캐시하므로, 별도 토큰 발급 노드가 필요 없다.
                - reqMode 는 반드시 "server". clientAuth 는 "body"(기본) 또는 "basic".
            """.trimIndent(),
        ),
        Skill(
            name = "페이지네이션 (cursor/offset)",
            description = "목록 API 를 페이지 단위로 순회",
            nodeTypes = listOf("http", "if"),
            builtin = true,
            instruction = """
                페이지네이션은 HTTP 노드 + IF 분기로 표현한다:
                - HTTP 로 한 페이지 조회(응답에 nextCursor/hasMore/총count 출력 선언).
                - IF 로 {{ hasMore@page }} == true 이면 다음 페이지 HTTP 로, 아니면 종료.
                - 커서/offset 은 다음 HTTP 노드의 쿼리 파라미터에 {{ nextCursor@page }} 로 바인딩.
                ⚠ 실행 엔진은 되돌아가는 사이클 반복을 자동 재실행하지 않으므로(위상정렬), 고정 페이지 수는 HTTP 노드를 나열하고
                동적 반복은 필요한 만큼만 노드를 두거나 재실행으로 처리한다고 안내한다.
            """.trimIndent(),
        ),
        Skill(
            name = "상태코드 검증 / 재시도 안내",
            description = "httpStatus 로 성공/실패 판정과 분기",
            nodeTypes = listOf("http", "assert", "if"),
            builtin = true,
            instruction = """
                모든 HTTP 노드는 {{ httpStatus@노드 }} 를 자동 출력한다.
                - 성공 단정: assert 노드 {{ httpStatus@h }} == 200.
                - 분기: IF {{ httpStatus@h }} == 200 → 성공 경로 / false → 오류 경로(로그 SET, 알림 등).
                - 4xx/5xx 를 만나면 오류 경로에서 SET 으로 사유를 기록하거나 form/wait 로 사람 개입.
            """.trimIndent(),
        ),
        Skill(
            name = "멱등키 (Idempotency-Key)",
            description = "중복 실행 방지 헤더",
            nodeTypes = listOf("http", "set"),
            builtin = true,
            instruction = """
                결제/주문 등 중복이 위험한 POST 는 Idempotency-Key 헤더를 붙인다:
                - SET 노드에서 key 를 만들고(예: 주문ID 기반), HTTP 헤더 Idempotency-Key: {{ key@set }} 로 바인딩.
                - 같은 키로 재요청하면 서버가 중복을 무시하도록.
            """.trimIndent(),
        ),
        Skill(
            name = "레거시 EUC-KR 전문",
            description = "국내 레거시 HTTP/TCP 인코딩",
            nodeTypes = listOf("http", "tcp"),
            builtin = true,
            instruction = """
                국내 레거시 시스템은 EUC-KR/MS949 를 쓴다.
                - HTTP: 노드 charset 을 "EUC-KR" 로(server 모드에서 요청 인코딩·응답 디코딩 적용).
                - TCP: 고정길이 전문에서 tcpEncoding "EUC-KR", 한글은 2바이트이므로 길이 계산 주의(전문 미리보기로 확인 권장).
            """.trimIndent(),
        ),
    )
}
