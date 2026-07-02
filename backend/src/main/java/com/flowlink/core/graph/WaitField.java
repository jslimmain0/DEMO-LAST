package com.flowlink.core.graph;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * input(사용자 입력) 노드가 사용자에게 요청하는 입력 한 개.
 * {@code type} 은 값 해석 힌트(string 기본 · number · boolean · json) — 브라우저가 confirm 시점에
 * 그 타입으로 파싱해 보내므로 서버는 저장만 한다.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record WaitField(
        String id,
        String key,
        String label,
        String type
) {
}
