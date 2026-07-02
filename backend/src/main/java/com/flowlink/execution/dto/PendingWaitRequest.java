package com.flowlink.execution.dto;

/**
 * wait(콜백 대기) 노드에서 실행이 중단됐을 때 브라우저에 넘기는 대기 명세.
 * 브라우저는 relay SSE 로 받은(또는 버퍼된) 콜백을 {@code receiveUrl} 기준으로 소비해 resume 하고,
 * {@code timeoutSec} 안에 콜백이 없으면 타임아웃 에러로 resume 한다.
 *
 * @param receiveUrl 이 노드의 콜백 수신 URL({relayBase}/cb/{relayRunId}/{nodeId}). relay 미연동 실행이면 null.
 */
public record PendingWaitRequest(
        String nodeId,
        String nodeName,
        int timeoutSec,
        String receiveUrl
) {
}
