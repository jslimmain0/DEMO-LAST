package com.flowlink.execution.dto;

/**
 * 콜백 대기(WAIT) 노드에서 실행이 중단됐을 때의 대기 정보.
 * 서버가 {@code url} 로 콜백을 받으면 스스로 재개하므로, 브라우저는 폴링으로 진행을 관전하며
 * {@code timeoutSec} 기준 카운트다운을 표시한다.
 */
public record PendingWaitRequest(
        String nodeId,
        String nodeName,
        String url,
        int timeoutSec
) {
}
