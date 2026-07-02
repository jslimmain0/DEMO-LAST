package com.flowlink.core.graph;

/** 노드 종류. 알 수 없는 type은 HTTP가 아닌 UNKNOWN으로 처리해 실행 시 명시적으로 실패시킨다. */
public enum NodeType {
    START,
    END,
    SET,
    HTTP,
    IF,
    /** 콜백/노티 수신 대기 — relay 수신 URL 로 외부 콜백이 올 때까지 실행을 중단한다. */
    WAIT,
    /** 폼 전송(팝업) — 브라우저가 팝업으로 hidden form 을 자동 submit 하고 즉시 다음 노드로 진행. */
    FORM,
    TRANSFORM,
    TCP,
    UNKNOWN;

    public static NodeType from(String raw) {
        if (raw == null) {
            return UNKNOWN;
        }
        return switch (raw.toLowerCase()) {
            case "start" -> START;
            case "end" -> END;
            case "set" -> SET;
            case "http" -> HTTP;
            case "if" -> IF;
            case "wait" -> WAIT;
            case "form" -> FORM;
            case "transform" -> TRANSFORM;
            case "tcp" -> TCP;
            default -> UNKNOWN;
        };
    }
}
