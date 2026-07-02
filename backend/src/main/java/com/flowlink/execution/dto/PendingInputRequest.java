package com.flowlink.execution.dto;

import java.util.List;

/**
 * input(사용자 입력) 노드에서 실행이 중단됐을 때, 브라우저가 모달(input box)로 띄울 입력 명세.
 * 사용자가 confirm 하면 {@code ResumeRequest.formValues} 로 값이 돌아와 노드 출력이 된다.
 * {@code type} 은 값 파싱 힌트(string 기본 · number · boolean · json) — 브라우저가 파싱해 보낸다.
 */
public record PendingInputRequest(
        String nodeId,
        String nodeName,
        String message,
        List<InputField> fields
) {
    public record InputField(String key, String label, String type) {
    }
}
