package com.flowlink.execution.dto;

import com.flowlink.core.domain.ExecutionStatus;
import com.flowlink.core.domain.TriggerType;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record ExecutionDetail(
        UUID id,
        UUID flowId,
        UUID flowVersionId,
        ExecutionStatus status,
        TriggerType trigger,
        String triggeredBy,
        Instant startedAt,
        Instant finishedAt,
        String error,
        List<NodeExecutionView> nodes,
        // client(클라이언트→서버) 모드 노드에서 중단된 경우, 브라우저가 대신 호출할 요청. 아니면 null.
        PendingClientRequest pendingClient,
        // 폼 전송(FORM) 노드에서 중단된 경우, 브라우저가 팝업으로 submit 할 폼 명세. 아니면 null.
        PendingFormRequest pendingForm,
        // 사용자 입력 대기(INPUT) 노드에서 중단된 경우, 브라우저가 띄울 입력 창 명세. 아니면 null.
        PendingInputRequest pendingInput,
        // 콜백 대기(WAIT) 노드에서 중단된 경우의 대기 정보(수신 URL·타임아웃). 아니면 null.
        PendingWaitRequest pendingWait
) {
}
