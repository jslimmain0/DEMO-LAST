package com.flowlink.execution.dto

import com.flowlink.core.domain.Execution
import com.flowlink.core.domain.ExecutionStatus
import com.flowlink.core.domain.TriggerType
import java.time.Instant
import java.util.UUID

data class ExecutionSummary(
    val id: UUID,
    val flowId: UUID,
    val flowName: String?,
    val status: ExecutionStatus,
    val trigger: TriggerType,
    val startedAt: Instant,
    val finishedAt: Instant?
) {
    companion object {
        @JvmStatic
        fun from(e: Execution, flowName: String?): ExecutionSummary {
            return ExecutionSummary(
                e.id, e.flowId, flowName, e.status, e.trigger,
                e.startedAt, e.finishedAt
            )
        }
    }
}
