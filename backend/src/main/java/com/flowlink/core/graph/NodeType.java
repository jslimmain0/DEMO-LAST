package com.flowlink.core.graph;

/** 노드 종류. 알 수 없는 type은 HTTP가 아닌 UNKNOWN으로 처리해 실행 시 명시적으로 실패시킨다. */
public enum NodeType {
    START,
    END,
    SET,
    HTTP,
    IF,
    FORM,   // 폼 전송(팝업) — 열고 submit 후 즉시 진행(fire-and-forget)
    WAIT,   // 콜백 대기 — /cb/{실행ID}/{노드ID} 수신까지 대기(타임아웃)
    INPUT,  // 사용자 입력 대기 — 입력 창을 띄우고 값을 출력으로
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
            case "form" -> FORM;
            case "wait" -> WAIT;
            case "input" -> INPUT;
            case "transform" -> TRANSFORM;
            case "tcp" -> TCP;
            default -> UNKNOWN;
        };
    }
}
