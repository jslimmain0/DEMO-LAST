package com.flowlink.core.graph;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * 노드 간 연결. fromPort는 분기 노드(if)의 'true'/'false' 또는 기본 'out'.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record GraphEdge(
        String id,
        String from,
        String fromPort,
        String to
) {
    public String fromPortOrDefault() {
        return fromPort == null || fromPort.isBlank() ? "out" : fromPort;
    }
}
