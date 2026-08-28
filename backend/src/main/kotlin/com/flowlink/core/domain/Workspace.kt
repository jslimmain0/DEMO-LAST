package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.hibernate.annotations.CreationTimestamp
import java.time.Instant
import java.util.UUID

/**
 * 워크스페이스 — 폴더/워크플로 위의 최상위 그룹.
 * 종류: PERSONAL(사용자별 자동 생성, 소유자 전용) · TEAM(멤버십 롤로 접근).
 * '공용' 워크스페이스는 DB 행 없는 가상 스코프(workspace_id = null) — 레거시 데이터 그대로 공용이 된다.
 */
@Entity
@Table(name = "workspace")
class Workspace {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "tenant_id", nullable = false)
    lateinit var tenantId: String
        private set

    @Column(nullable = false)
    lateinit var name: String

    /** PERSONAL | TEAM */
    @Column(nullable = false, length = 16)
    lateinit var kind: String
        private set

    /** PERSONAL 의 소유 사용자명(TEAM 은 null — 멤버십 OWNER 가 소유). */
    @Column(name = "owner_username", length = 190)
    var ownerUsername: String? = null
        private set

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant? = null
        private set

    companion object {
        const val KIND_PERSONAL = "PERSONAL"
        const val KIND_TEAM = "TEAM"

        fun personal(tenantId: String, username: String, name: String): Workspace = Workspace().apply {
            this.id = UUID.randomUUID()
            this.tenantId = tenantId
            this.name = name
            this.kind = KIND_PERSONAL
            this.ownerUsername = username
        }

        fun team(tenantId: String, name: String): Workspace = Workspace().apply {
            this.id = UUID.randomUUID()
            this.tenantId = tenantId
            this.name = name
            this.kind = KIND_TEAM
        }
    }
}
