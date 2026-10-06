package com.flowlink.trigger

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.core.domain.FlowTrigger
import com.flowlink.core.domain.TriggerType
import java.time.Instant
import java.util.UUID

/** 트리거 표시용 — webhookToken 은 소유자에게만 노출(무인증 실행 경로라 비밀값). */
data class TriggerView(
    val id: UUID,
    val flowId: UUID,
    val type: TriggerType,
    val enabled: Boolean,
    val cron: String?,
    val webhookToken: String?,
    val versionNo: Int?,
    val nextRunAt: Instant?,
    val lastRunAt: Instant?,
    val createdAt: Instant,
) {
    companion object {
        @JvmStatic
        fun from(t: FlowTrigger): TriggerView = TriggerView(
            t.id, t.flowId, t.type, t.enabled, t.cron, t.webhookToken,
            t.versionNo, t.nextRunAt, t.lastRunAt, t.createdAt,
        )
    }
}

/** 트리거 생성 — type=SCHEDULE 이면 cron 필수, WEBHOOK 이면 토큰 자동 발급. */
data class CreateTriggerRequest(
    val type: TriggerType,
    val cron: String? = null,
    val versionNo: Int? = null,
    val input: JsonNode? = null,
    val enabled: Boolean = true,
)

/** 트리거 부분 수정. null 필드는 변경 안 함(단, input 은 null 로도 비울 수 있어 별도 처리). */
data class UpdateTriggerRequest(
    val enabled: Boolean? = null,
    val cron: String? = null,
    val versionNo: Int? = null,
    val input: JsonNode? = null,
)
