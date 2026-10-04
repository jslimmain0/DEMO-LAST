package com.flowlink.maintenance

import com.flowlink.core.domain.ExecutionStatus
import jakarta.persistence.EntityManager
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

/** 실행 이력 삭제와 같은 트랜잭션에서 전송·콜백의 암호화 본문도 정리한다. */
@Service
class ExecutionArtifactCleanup(private val em: EntityManager) {
    @Transactional
    fun purge(tenant: String?, flowId: UUID?, before: Instant?) {
        val matching = "SELECT e.id FROM Execution e WHERE (:tenant IS NULL OR e.tenantId = :tenant) " +
            "AND (:flowId IS NULL OR e.flowId = :flowId) AND (:before IS NULL OR e.startedAt < :before) " +
            "AND e.status NOT IN :active"
        // 작업 ID는 보존한다. 이력 정리 후 같은 요청이 도착해도 외부 호출을 재실행하지 않는다.
        val commands = listOf(
            "UPDATE AgentTask t SET t.status = 'ACKED', t.requestData = NULL, t.resultData = NULL " +
                "WHERE t.delegation = false AND t.executionId IN ($matching)",
            "DELETE FROM WaitCallback c WHERE c.executionId IN ($matching)",
            "DELETE FROM ExecutionSuspension s WHERE s.executionId IN ($matching)",
        )
        commands.forEach { command ->
            em.createQuery(command).setParameter("tenant", tenant).setParameter("flowId", flowId)
                .setParameter("before", before)
                .setParameter("active", listOf(ExecutionStatus.RUNNING, ExecutionStatus.WAITING))
                .executeUpdate()
        }
    }
}
