package com.flowlink.core.graph;

/** 노드 종류. 알 수 없는 type은 HTTP가 아닌 UNKNOWN으로 처리해 실행 시 명시적으로 실패시킨다. */
public enum NodeType {
    START,
    END,
    SET,
    HTTP,
    IF,
    WAIT,
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
            default -> UNKNOWN;
        };
    }
}
