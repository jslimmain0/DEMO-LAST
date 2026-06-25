package com.flowlink.core.graph;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** wait(휴먼태스크) 노드가 사용자에게 요청하는 입력 한 개. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record WaitField(
        String id,
        String key,
        String label
) {
}
