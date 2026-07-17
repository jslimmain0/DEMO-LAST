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
 * 자동 실행 트리거 — 스케줄(cron) 또는 인바운드 웹훅. 실행 자체는 P2 비동기 워커 풀을 그대로 쓰고,
 * 트리거는 "언제/무엇으로 run() 을 부를지"만 담는다.
 * - SCHEDULE: [cron] 식 + [nextRunAt](다음 발화 시각, 스케줄러가 갱신)
 * - WEBHOOK: 추측 불가한 [webhookToken] → POST /hooks/{token} 로 실행(본문은 input)
 * [versionNo] null=현재 버전, [inputJson]=고정 입력(RunRequest.input).
 */
@Entity
@Table(name = "flow_trigger")
class FlowTrigger {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "tenant_id", nullable = false, updatable = false)
    lateinit var tenantId: String
        private set

    @Column(name = "flow_id", nullable = false)
    lateinit var flowId: UUID
        private set

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    lateinit var type: TriggerType
        private set

    @Column(nullable = false)
    var enabled: Boolean = true

    @Column(length = 120)
    var cron: String? = null

    @Column(name = "webhook_token", length = 64)
    var webhookToken: String? = null

    @Column(name = "version_no")
    var versionNo: Int? = null

    @Column(name = "input_json", columnDefinition = "text")
    var inputJson: String? = null

    @Column(name = "next_run_at")
    var nextRunAt: Instant? = null

    @Column(name = "last_run_at")
    var lastRunAt: Instant? = null

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    lateinit var createdAt: Instant
        private set

    companion object {
        @JvmStatic
        fun create(tenantId: String, flowId: UUID, type: TriggerType): FlowTrigger {
            val t = FlowTrigger()
            t.id = UUID.randomUUID()
            t.tenantId = tenantId
            t.flowId = flowId
            t.type = type
            return t
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is FlowTrigger) return false
        if (!this::id.isInitialized || !other::id.isInitialized) return false
        return id == other.id
    }

    override fun hashCode(): Int = Objects.hashCode(if (this::id.isInitialized) id else null)
}
