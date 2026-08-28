package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import jakarta.persistence.UniqueConstraint
import org.hibernate.annotations.CreationTimestamp
import java.time.Instant
import java.util.UUID

/** 워크스페이스 멤버십 — 사용자별 롤(OWNER/EDITOR/VIEWER). TEAM 워크스페이스 접근의 단위. */
@Entity
@Table(name = "workspace_member", uniqueConstraints = [UniqueConstraint(columnNames = ["workspace_id", "username"])])
class WorkspaceMember {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "workspace_id", nullable = false)
    lateinit var workspaceId: UUID
        private set

    @Column(nullable = false, length = 190)
    lateinit var username: String
        private set

    /** OWNER | EDITOR | VIEWER */
    @Column(nullable = false, length = 16)
    lateinit var role: String

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant? = null
        private set

    companion object {
        const val ROLE_OWNER = "OWNER"
        const val ROLE_EDITOR = "EDITOR"
        const val ROLE_VIEWER = "VIEWER"

        fun of(workspaceId: UUID, username: String, role: String): WorkspaceMember = WorkspaceMember().apply {
            this.id = UUID.randomUUID()
            this.workspaceId = workspaceId
            this.username = username
            this.role = role
        }
    }
}
