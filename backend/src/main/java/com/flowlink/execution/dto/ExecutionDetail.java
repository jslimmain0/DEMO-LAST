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
        // form(폼 전송·팝업) 노드에서 중단된 경우, 브라우저가 팝업으로 제출할 폼 명세. 아니면 null.
        PendingFormRequest pendingForm,
        // wait(콜백 대기) 노드에서 중단된 경우, 브라우저가 대기할 콜백 명세. 아니면 null.
        PendingWaitRequest pendingWait
) {
}
