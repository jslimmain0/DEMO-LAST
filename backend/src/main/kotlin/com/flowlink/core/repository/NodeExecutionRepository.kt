package com.flowlink.core.repository

import com.flowlink.core.domain.NodeExecution
import org.springframework.data.jpa.repository.JpaRepository
import java.util.UUID

interface NodeExecutionRepository : JpaRepository<NodeExecution, UUID> {

    fun findByExecutionIdOrderBySeqAsc(executionId: UUID): List<NodeExecution>

    /** 이력 정리(purge) — 조건에 걸리는 실행들의 노드 기록 일괄 삭제(실행 행 삭제 전에 호출). */
    @org.springframework.data.jpa.repository.Modifying
    @org.springframework.data.jpa.repository.Query(
        "DELETE FROM NodeExecution ne WHERE ne.executionId IN (" +
            "SELECT e.id FROM Execution e WHERE e.tenantId = :tenant " +
            "AND (:flowId IS NULL OR e.flowId = :flowId) " +
            "AND (:before IS NULL OR e.startedAt < :before) " +
            "AND e.status NOT IN :active)"
    )
    fun purgeForExecutions(
        @org.springframework.data.repository.query.Param("tenant") tenant: String,
        @org.springframework.data.repository.query.Param("flowId") flowId: UUID?,
        @org.springframework.data.repository.query.Param("before") before: java.time.Instant?,
        @org.springframework.data.repository.query.Param("active") active: Collection<com.flowlink.core.domain.ExecutionStatus>,
    ): Int

    /** 보존 정책 스윕(테넌트 무관) — 삭제 대상 실행들의 노드 기록 선삭제. */
    @org.springframework.data.jpa.repository.Modifying
    @org.springframework.data.jpa.repository.Query(
        "DELETE FROM NodeExecution ne WHERE ne.executionId IN (" +
            "SELECT e.id FROM Execution e WHERE e.startedAt < :before AND e.status NOT IN :active)"
    )
    fun purgeBefore(
        @org.springframework.data.repository.query.Param("before") before: java.time.Instant,
        @org.springframework.data.repository.query.Param("active") active: Collection<com.flowlink.core.domain.ExecutionStatus>,
    ): Int
}
