package com.flowlink.core.repository

import com.flowlink.core.domain.Execution
import com.flowlink.core.domain.ExecutionStatus
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface ExecutionRepository : JpaRepository<Execution, UUID> {

    fun findByTenantIdOrderByStartedAtDesc(tenantId: String, pageable: Pageable): List<Execution>

    fun findByFlowIdOrderByStartedAtDesc(flowId: UUID, pageable: Pageable): List<Execution>

    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<Execution>

    /** 기동 복구용 — 진행 중(RUNNING/WAITING) 실행 전체(테넌트 무관, 서버 수준 reconcile). */
    fun findByStatusIn(statuses: Collection<ExecutionStatus>): List<Execution>
}
