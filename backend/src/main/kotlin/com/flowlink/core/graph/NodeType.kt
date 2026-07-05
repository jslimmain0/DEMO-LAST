package com.flowlink.core.graph

/** 노드 종류. 알 수 없는 type은 HTTP가 아닌 UNKNOWN으로 처리해 실행 시 명시적으로 실패시킨다. */
enum class NodeType {
    START,
    END,
    SET,
    HTTP,
    IF,

    /** 콜백/노티 수신 대기 — relay 수신 URL 로 외부 콜백이 올 때까지 실행을 중단한다. */
    WAIT,

    /** 폼 전송(팝업) — 브라우저가 팝업으로 hidden form 을 자동 submit 하고 즉시 다음 노드로 진행. */
    FORM,

    /** 사용자 입력 대기 — 브라우저 모달(input box)에 값을 입력·confirm 하면 그 값이 노드 출력이 된다. */
    INPUT,

    /** 검증 — IF 와 같은 SpEL 조건이 거짓이면 노드 실패(=실행 FAILED). 테스트 시나리오의 assert 용. */
    ASSERT,
    TRANSFORM,
    TCP,
    UNKNOWN,
    ;

    companion object {
        @JvmStatic
        fun from(raw: String?): NodeType = when (raw?.lowercase()) {
            "start" -> START
            "end" -> END
            "set" -> SET
            "http" -> HTTP
            "if" -> IF
            "wait" -> WAIT
            "form" -> FORM
            "input" -> INPUT
            "assert" -> ASSERT
            "transform" -> TRANSFORM
            "tcp" -> TCP
            else -> UNKNOWN
        }
    }
}
