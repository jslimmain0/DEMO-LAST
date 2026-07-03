package com.flowlink.execution.dto;

import java.util.List;

/**
 * 사용자 입력 대기(INPUT) 노드에서 실행이 중단됐을 때, 브라우저가 띄울 입력 창 명세.
 * 사용자가 제출한 값이 노드 출력이 되어 다운스트림에서 {@code {{ key }}} 로 바인딩된다.
 */
public record PendingInputRequest(
        String nodeId,
        String nodeName,
        String msg,
        List<InputField> fields
) {
    public record InputField(String key, String label) {
    }
}
