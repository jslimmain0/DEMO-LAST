package com.flowlink.execution.dto

import com.flowlink.core.domain.ExecutionStatus
import com.flowlink.core.domain.TriggerType
import java.time.Instant
import java.util.UUID

data class ExecutionDetail(
    val id: UUID,
    val flowId: UUID,
    val flowVersionId: UUID,
    val status: ExecutionStatus,
    val trigger: TriggerType,
    val triggeredBy: String?,
    val startedAt: Instant,
    val finishedAt: Instant?,
    val error: String?,
    val nodes: List<NodeExecutionView>,
    // client(클라이언트→서버) 모드 노드에서 중단된 경우, 브라우저가 대신 호출할 요청. 아니면 null.
    val pendingClient: PendingClientRequest?,
    // form(폼 전송·팝업) 노드에서 중단된 경우, 브라우저가 팝업으로 제출할 폼 명세. 아니면 null.
    val pendingForm: PendingFormRequest?,
    // wait(콜백 대기) 노드에서 중단된 경우, 브라우저가 대기할 콜백 명세. 아니면 null.
    val pendingWait: PendingWaitRequest?,
    // input(사용자 입력) 노드에서 중단된 경우, 브라우저가 모달로 띄울 입력 명세. 아니면 null.
    val pendingInput: PendingInputRequest?
)
