package com.flowlink.execution.dto;

import java.util.Map;

/**
 * client(클라이언트→서버) 모드 HTTP 노드에서 실행이 중단됐을 때, 브라우저가 대신 호출하도록
 * 넘기는 조립된 요청. 프론트는 이 정보로 {@code fetch} 한 뒤 결과를 resume 으로 돌려준다.
 */
public record PendingClientRequest(
        String nodeId,
        String nodeName,
        String method,
        String url,
        Map<String, String> headers,
        String body,
        String respType
) {
}
