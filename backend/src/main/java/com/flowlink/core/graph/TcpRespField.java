package com.flowlink.core.graph;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** 고정길이 TCP 응답 전문에서 잘라낼 출력 필드(바이트 단위). */
@JsonIgnoreProperties(ignoreUnknown = true)
public record TcpRespField(
        String id,
        String name,
        Integer length,
        String encoding
) {
    public int lengthOrZero() {
        return length == null ? 0 : length;
    }
}
