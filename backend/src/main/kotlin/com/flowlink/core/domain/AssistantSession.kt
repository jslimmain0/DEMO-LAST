package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.hibernate.annotations.CreationTimestamp
import org.hibernate.annotations.UpdateTimestamp
import java.time.Instant
import java.util.Objects
import java.util.UUID

/**
 * AI 어시스턴트 대화 세션 — 사용자별(tenant + username)로 저장해 목록/이어하기.
 * [messages] 는 대화 턴 JSON 배열(role/content + 선택적 제안 graph) 원문. 그래프는 라운드트립으로만 보존.
 */
@Entity
@Table(name = "assistant_session")
class AssistantSession {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "tenant_id", nullable = false, updatable = false)
    lateinit var tenantId: String
        private set

    @Column(nullable = false, length = 180, updatable = false)
    lateinit var username: String
        private set

    @Column(nullable = false, length = 300)
    var title: String = "새 대화"

    @Column(name = "messages", columnDefinition = "text", nullable = false)
    var messages: String = "[]"

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    lateinit var createdAt: Instant
        private set

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    lateinit var updatedAt: Instant
        private set

    companion object {
        @JvmStatic
        fun create(tenantId: String, username: String, title: String, messages: String): AssistantSession {
            val s = AssistantSession()
            s.id = UUID.randomUUID()
            s.tenantId = tenantId
            s.username = username
            s.title = title
            s.messages = messages
            return s
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is AssistantSession) return false
        if (!this::id.isInitialized || !other::id.isInitialized) return false
        return id == other.id
    }

    override fun hashCode(): Int = Objects.hashCode(if (this::id.isInitialized) id else null)
}
