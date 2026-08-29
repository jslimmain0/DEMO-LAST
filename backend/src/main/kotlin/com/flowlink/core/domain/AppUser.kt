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
 * 앱 사용자 레지스트리 — 관리자 화면의 사용자 목록/전역 롤/가입 상태.
 * **GitHub 로그인 = 가입 신청**: 처음 로그인(활동)이 관측되면 PENDING 으로 자동 등록되고,
 * 관리자가 관리 콘솔에서 승인(APPROVED)/차단(BLOCKED)한다. 전역 롤: ADMIN | MEMBER.
 * (부트스트랩 관리자는 env `flowlink.auth.admin-logins` — DB 롤과 OR 판정. status=null 은 레거시 행 = 승인 간주)
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

    /** PENDING(가입 신청) | APPROVED(승인) | BLOCKED(차단). null=레거시 행(승인 간주 — dev H2 ddl-auto 호환). */
    @Column(length = 16)
    var status: String? = null

    @Column(name = "last_seen_at")
    var lastSeenAt: Instant? = null

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant? = null
        private set

    /** 유효 상태 — null(레거시)은 APPROVED 로 간주. */
    fun effectiveStatus(): String = status ?: STATUS_APPROVED

    companion object {
        const val ROLE_ADMIN = "ADMIN"
        const val ROLE_MEMBER = "MEMBER"
        const val STATUS_PENDING = "PENDING"
        const val STATUS_APPROVED = "APPROVED"
        const val STATUS_BLOCKED = "BLOCKED"

        fun of(tenantId: String, username: String, status: String? = null): AppUser = AppUser().apply {
            this.id = UUID.randomUUID()
            this.tenantId = tenantId
            this.username = username
            this.status = status
        }
    }
}
