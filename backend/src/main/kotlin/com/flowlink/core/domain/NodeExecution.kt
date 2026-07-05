package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.Id
import jakarta.persistence.Index
import jakarta.persistence.Table
import java.time.Instant
import java.util.Objects
import java.util.UUID

/**
 * 실행 중 개별 노드의 결과 한 건. 요청/응답 텍스트와 산출 출력을 보관해 디버깅·감사·재현을 돕는다.
 */
@Entity
@Table(
    name = "node_execution",
    indexes = [Index(name = "idx_node_exec_execution", columnList = "execution_id")]
)
class NodeExecution {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "execution_id", nullable = false)
    lateinit var executionId: UUID
        private set

    @Column(name = "node_id", nullable = false)
    lateinit var nodeId: String
        private set

    @Column(name = "node_name")
    var nodeName: String? = null
        private set

    @Column(name = "node_type", length = 20)
    var nodeType: String? = null
        private set

    /** 같은 실행 내 노드 처리 순서. */
    @Column(name = "seq", nullable = false)
    var seq: Int = 0
        private set

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    lateinit var status: NodeExecutionStatus
        private set

    @Column(name = "http_status")
    var httpStatus: Int? = null
        private set

    @Column(name = "duration_ms")
    var durationMs: Long? = null
        private set

    @Column(name = "ok", nullable = false)
    var isOk: Boolean = false
        private set

    @Column(name = "request_text", columnDefinition = "text")
    var requestText: String? = null
        private set

    @Column(name = "response_text", columnDefinition = "text")
    var responseText: String? = null
        private set

    /** 이 노드가 ctx 로 내보낸 출력(JSON 문자열, 시크릿은 마스킹된 형태). */
    @Column(name = "output_json", columnDefinition = "text")
    var outputJson: String? = null
        private set

    @Column(name = "started_at")
    var startedAt: Instant? = null
        private set

    @Column(name = "finished_at")
    var finishedAt: Instant? = null
        private set

    fun complete(
        status: NodeExecutionStatus, ok: Boolean, httpStatus: Int?,
        requestText: String?, responseText: String?, outputJson: String?, durationMs: Long
    ) {
        this.status = status
        this.isOk = ok
        this.httpStatus = httpStatus
        this.requestText = requestText
        this.responseText = responseText
        this.outputJson = outputJson
        this.durationMs = durationMs
        this.finishedAt = Instant.now()
    }

    companion object {
        @JvmStatic
        fun of(
            executionId: UUID, nodeId: String, nodeName: String?,
            nodeType: String?, seq: Int
        ): NodeExecution {
            val n = NodeExecution()
            n.id = UUID.randomUUID()
            n.executionId = executionId
            n.nodeId = nodeId
            n.nodeName = nodeName
            n.nodeType = nodeType
            n.seq = seq
            n.status = NodeExecutionStatus.RUNNING
            n.startedAt = Instant.now()
            n.isOk = false
            return n
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) {
            return true
        }
        if (other !is NodeExecution) {
            return false
        }
        if (!this::id.isInitialized || !other::id.isInitialized) {
            return false
        }
        return id == other.id
    }

    override fun hashCode(): Int = Objects.hashCode(if (this::id.isInitialized) id else null)
}
