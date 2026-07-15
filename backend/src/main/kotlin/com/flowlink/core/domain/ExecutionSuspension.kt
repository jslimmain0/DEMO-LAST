package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.hibernate.annotations.UpdateTimestamp
import java.time.Instant
import java.util.UUID

/**
 * 중단(WAITING) 실행의 재개 상태 영속 — 서버 재시작/배포에도 wait/client/form/input 실행이 살아남는다.
 *
 * - `run_state`: [com.flowlink.execution.engine.RunStateSnapshot] JSON 을 AES-GCM 암호화(base64)한 것
 *   (ctx 에 SET 시크릿이 비마스킹으로 들어 있어 평문 저장 금지 — StateCrypto).
 * - `outcome_json`: 중단 시점 pending 명세(4종 DTO) — `GET /executions/{id}` 가 WAITING 중 pending 을
 *   반환하는 계약을 재시작 후에도 지키기 위한 것.
 * - 이중 재개 방지: **pending_node_id 조건부 DELETE 의 영향 행수가 1인 쪽만 재개 권한(claim 승자)** —
 *   콜백/타임아웃/브라우저 resume 이 경합해도 한 쪽만 이어 실행한다.
 */
@Entity
@Table(name = "execution_suspension")
class ExecutionSuspension {

    @Id
    @Column(name = "execution_id", nullable = false, updatable = false)
    lateinit var executionId: UUID
        private set

    @Column(name = "tenant_id", nullable = false)
    lateinit var tenantId: String
        private set

    @Column(name = "pending_node_id", nullable = false, length = 80)
    lateinit var pendingNodeId: String

    @Column(name = "run_state", columnDefinition = "text", nullable = false)
    lateinit var runState: String

    @Column(name = "outcome_json", columnDefinition = "text")
    var outcomeJson: String? = null

    /** wait 노드의 타임아웃 데드라인(그 외 pending 은 null) — 재기동 시 재무장 기준. */
    @Column(name = "wait_deadline")
    var waitDeadline: Instant? = null

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    lateinit var updatedAt: Instant
        private set

    companion object {
        @JvmStatic
        fun of(
            executionId: UUID, tenantId: String, pendingNodeId: String,
            runState: String, outcomeJson: String?, waitDeadline: Instant?,
        ): ExecutionSuspension {
            val s = ExecutionSuspension()
            s.executionId = executionId
            s.tenantId = tenantId
            s.pendingNodeId = pendingNodeId
            s.runState = runState
            s.outcomeJson = outcomeJson
            s.waitDeadline = waitDeadline
            return s
        }
    }
}
