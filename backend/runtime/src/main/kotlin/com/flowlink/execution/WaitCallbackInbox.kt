package com.flowlink.execution

import com.flowlink.common.crypto.CryptoProvider
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.execution.dto.ResumeRequest.CallbackPayload
import jakarta.persistence.*
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "flowlink_wait_callback", indexes = [Index(name = "idx_wait_callback_exec", columnList = "execution_id")])
class WaitCallback {
    @Id var id: UUID = UUID.randomUUID()
    @Column(name = "execution_id", nullable = false) var executionId: UUID = UUID.randomUUID()
    @Column(name = "node_id", nullable = false) var nodeId: String = ""
    @Column(columnDefinition = "text") var payload: String? = null
    @Column(name = "received_at", nullable = false) var receivedAt: Instant = Instant.now()
}
interface WaitCallbackRepository : JpaRepository<WaitCallback, UUID> {
    fun deleteByExecutionId(executionId: UUID)
}

/** 호출자는 실행 checkpoint를 잠근 뒤 유효한 WAIT 노드인지 검증한다. 첫 수신만 소비한다. */
@Service
class WaitCallbackInbox(private val repo: WaitCallbackRepository, private val crypto: CryptoProvider, private val json: JsonService) {
    @Transactional
    fun clear(execId: UUID) = repo.deleteByExecutionId(execId)

    @Transactional
    fun offer(execId: UUID, nodeId: String, callback: CallbackPayload) {
        val id = key(execId, nodeId)
        if (repo.existsById(id)) return
        val raw = json.toJson(callback)
        if (raw.toByteArray().size > 5 * 1024 * 1024) throw BadRequestException("콜백은 5MB 이하여야 합니다.")
        repo.save(WaitCallback().apply { this.id = id; executionId = execId; this.nodeId = nodeId; payload = crypto.encrypt(raw) })
    }
    @Transactional
    fun take(execId: UUID, nodeId: String): CallbackPayload? {
        val row = repo.findById(key(execId, nodeId)).orElse(null) ?: return null
        val data = row.payload ?: return null
        val result = json.mapper().readValue(crypto.decrypt(data), CallbackPayload::class.java)
        row.payload = null // 중복 수신 표식만 남기며 본문은 실행 checkpoint로 이동한다.
        return result
    }
    private fun key(execId: UUID, nodeId: String) = UUID.nameUUIDFromBytes("$execId/$nodeId".toByteArray(Charsets.UTF_8))
}
