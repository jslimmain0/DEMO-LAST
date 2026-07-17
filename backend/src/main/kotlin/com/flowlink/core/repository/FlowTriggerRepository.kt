package com.flowlink.core.repository

import com.flowlink.core.domain.FlowTrigger
import com.flowlink.core.domain.TriggerType
import org.springframework.data.jpa.repository.JpaRepository
import java.time.Instant
import java.util.Optional
import java.util.UUID

interface FlowTriggerRepository : JpaRepository<FlowTrigger, UUID> {

    fun findByFlowIdAndTenantId(flowId: UUID, tenantId: String): List<FlowTrigger>

    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<FlowTrigger>

    fun findByWebhookToken(webhookToken: String): Optional<FlowTrigger>

    /** 스케줄러 폴러 — 발화할 SCHEDULE 트리거(테넌트 무관, 백그라운드). */
    fun findByTypeAndEnabledTrueAndNextRunAtLessThanEqual(type: TriggerType, at: Instant): List<FlowTrigger>
}
