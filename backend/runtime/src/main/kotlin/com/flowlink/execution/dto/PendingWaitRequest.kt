package com.flowlink.execution.dto

/**
 * wait(콜백 대기) 노드에서 실행이 중단됐을 때 브라우저에 넘기는 대기 명세(표시·진행 상황용).
 * 콜백은 백엔드가 [receiveUrl] 로 직접 받아 재개하고([com.flowlink.execution.RelayController]),
 * [timeoutSec] 안에 콜백이 없으면 백엔드가 타임아웃으로 자동 재개(실행 FAILED)한다.
 *
 * [receiveUrl] 은 이 노드의 콜백 수신 URL({baseUrl}/relay/{execId}/cb/{nodeId}).
 */
data class PendingWaitRequest(
    val nodeId: String?,
    val nodeName: String?,
    val timeoutSec: Int,
    val receiveUrl: String?
)
