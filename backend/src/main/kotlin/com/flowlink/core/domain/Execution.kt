package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.hibernate.annotations.CreationTimestamp
import java.time.Instant
import java.util.Objects
import java.util.UUID

/**
 * 워크플로 1회 실행(run)의 헤더. 노드별 상세는 [NodeExecution] 에 1:N 으로 기록된다.
 * 실행 이력을 영속화해 감사/재현/관측의 기반으로 삼는다.
 */
@Entity
@Table(name = "execution")
class Execution {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "tenant_id", nullable = false)
    lateinit var tenantId: String
        private set

    @Column(name = "flow_id", nullable = false)
    lateinit var flowId: UUID
        private set

    @Column(name = "flow_version_id", nullable = false)
    lateinit var flowVersionId: UUID
        private set

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    lateinit var status: ExecutionStatus
        private set

    @Enumerated(EnumType.STRING)
    @Column(name = "trigger_type", nullable = false, length = 20)
    lateinit var trigger: TriggerType
        private set

    @Column(name = "triggered_by")
    var triggeredBy: String? = null
        private set

    /** 실행 시작 시 주입한 입력 변수(JSON 문자열). */
    @Column(name = "input_json", columnDefinition = "text")
    var inputJson: String? = null
        private set

    @Column(name = "started_at")
    lateinit var startedAt: Instant
        private set

    @Column(name = "finished_at")
    var finishedAt: Instant? = null
        private set

    @Column(columnDefinition = "text")
    var error: String? = null
        private set

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    lateinit var createdAt: Instant
        private set

    fun markSucceeded() {
        this.status = ExecutionStatus.SUCCEEDED
        this.finishedAt = Instant.now()
    }

    fun markFailed(error: String?) {
        this.status = ExecutionStatus.FAILED
        this.error = error
        this.finishedAt = Instant.now()
    }

    fun markWaiting() {
        this.status = ExecutionStatus.WAITING
    }

    /** 사용자 중단(⏹) — 실패가 아니라 취소로 마감한다. */
    fun markCancelled(reason: String?) {
        this.status = ExecutionStatus.CANCELLED
        this.error = reason
        this.finishedAt = Instant.now()
    }

    companion object {
        @JvmStatic
        fun start(
            tenantId: String, flowId: UUID, flowVersionId: UUID,
            trigger: TriggerType, triggeredBy: String?, inputJson: String?
        ): Execution {
            val e = Execution()
            e.id = UUID.randomUUID()
            e.tenantId = tenantId
            e.flowId = flowId
            e.flowVersionId = flowVersionId
            e.trigger = trigger
            e.triggeredBy = triggeredBy
            e.inputJson = inputJson
            e.status = ExecutionStatus.RUNNING
            e.startedAt = Instant.now()
            return e
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) {
            return true
        }
        if (other !is Execution) {
            return false
        }
        if (!this::id.isInitialized || !other::id.isInitialized) {
            return false
        }
        return id == other.id
    }

    override fun hashCode(): Int = Objects.hashCode(if (this::id.isInitialized) id else null)
}
