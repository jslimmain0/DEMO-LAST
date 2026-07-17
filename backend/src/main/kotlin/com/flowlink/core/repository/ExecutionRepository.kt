package com.flowlink.core.repository

import com.flowlink.core.domain.Execution
import com.flowlink.core.domain.ExecutionStatus
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.time.Instant
import java.util.Optional
import java.util.UUID

interface ExecutionRepository : JpaRepository<Execution, UUID> {

    fun findByTenantIdOrderByStartedAtDesc(tenantId: String, pageable: Pageable): List<Execution>

    fun findByFlowIdOrderByStartedAtDesc(flowId: UUID, pageable: Pageable): List<Execution>

    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<Execution>

    /** 기동 복구용 — 진행 중(RUNNING/WAITING) 실행 전체(테넌트 무관, 서버 수준 reconcile). */
    fun findByStatusIn(statuses: Collection<ExecutionStatus>): List<Execution>

    /**
     * 실행 이력 필터 조회(테넌트 스코프 + 선택 status/flowId/기간). null 파라미터는 무시(전체).
     * 페이지네이션은 Pageable(offset+limit)로 — 실행량 많은 팀의 과거 실패 추적용.
     */
    @Query(
        "SELECT e FROM Execution e WHERE e.tenantId = :tenant " +
            "AND (:status IS NULL OR e.status = :status) " +
            "AND (:flowId IS NULL OR e.flowId = :flowId) " +
            "AND (:from IS NULL OR e.startedAt >= :from) " +
            "AND (:to IS NULL OR e.startedAt <= :to) " +
            "ORDER BY e.startedAt DESC"
    )
    fun findFiltered(
        @Param("tenant") tenant: String,
        @Param("status") status: ExecutionStatus?,
        @Param("flowId") flowId: UUID?,
        @Param("from") from: Instant?,
        @Param("to") to: Instant?,
        pageable: Pageable,
    ): List<Execution>
}
