package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import jakarta.persistence.UniqueConstraint
import org.hibernate.annotations.CreationTimestamp
import java.time.Instant
import java.util.UUID

/**
 * 앱 사용자 레지스트리 — 관리자 화면의 사용자 목록/전역 롤.
 * 처음 활동이 관측된 사용자를 자동 등록(GitHub 로그인명 기준). 전역 롤: ADMIN | MEMBER.
 * (부트스트랩 관리자는 env `flowlink.auth.admin-logins` — DB 롤과 OR 판정)
 */
@Entity
@Table(name = "app_user", uniqueConstraints = [UniqueConstraint(columnNames = ["tenant_id", "username"])])
class AppUser {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "tenant_id", nullable = false)
    lateinit var tenantId: String
        private set

    @Column(nullable = false, length = 190)
    lateinit var username: String
        private set

    /** ADMIN | MEMBER */
    @Column(name = "global_role", nullable = false, length = 16)
    var globalRole: String = ROLE_MEMBER

    @Column(name = "last_seen_at")
    var lastSeenAt: Instant? = null

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant? = null
        private set

    companion object {
        const val ROLE_ADMIN = "ADMIN"
        const val ROLE_MEMBER = "MEMBER"

        fun of(tenantId: String, username: String): AppUser = AppUser().apply {
            this.id = UUID.randomUUID()
            this.tenantId = tenantId
            this.username = username
        }
    }
}
