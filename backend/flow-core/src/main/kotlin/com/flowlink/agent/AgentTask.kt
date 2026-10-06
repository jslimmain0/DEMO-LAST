package com.flowlink.agent

import jakarta.persistence.*
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Lock
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.time.Instant
import java.util.UUID

/** 실행 이력과 별개인 전송 작업. 요청·미확인 결과는 암호화하고 ACK 후 정리한다. */
@Entity
@Table(name = "flowlink_agent_task", indexes = [Index(name = "idx_agent_task_exec", columnList = "execution_id"), Index(name = "idx_agent_task_status", columnList = "status")])
class AgentTask {
    @Id var id: UUID = UUID.randomUUID()
    @Column(name = "execution_id", nullable = false) var executionId: UUID = UUID.randomUUID()
    @Column(name = "tenant_id", nullable = false) var tenantId: String = "default"
    @Column(nullable = false) var username: String = ""
    @Column(name = "workspace_id") var workspaceId: UUID? = null
    @Column(name = "node_id", nullable = false) var nodeId: String = ""
    @Column(name = "node_name") var nodeName: String? = null
    @Column(nullable = false, length = 12) var agent: String = "server"
    @Column(name = "device_id", nullable = false) var deviceId: String = ""
    @Column(nullable = false, length = 16) var status: String = "PENDING"
    @Column(nullable = false) var delegation: Boolean = false
    @Column(name = "claim_token", length = 100) var claimToken: String? = null
    @Column(name = "request_data", columnDefinition = "text") var requestData: String? = null
    @Column(name = "result_data", columnDefinition = "text") var resultData: String? = null
    @Column(name = "duration_ms", nullable = false) var durationMs: Long = 0
    @Column(columnDefinition = "text") var error: String? = null
    @Column(name = "updated_at", nullable = false) var updatedAt: Instant = Instant.now()
}

interface AgentTaskRepository : JpaRepository<AgentTask, UUID> {
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select t from AgentTask t where t.id = :id")
    fun locked(@Param("id") id: UUID): AgentTask?
    fun findByExecutionId(executionId: UUID): List<AgentTask>
    fun findByStatusIn(statuses: Collection<String>): List<AgentTask>
}
