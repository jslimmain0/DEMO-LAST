package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import jakarta.persistence.Version
import org.hibernate.annotations.CreationTimestamp
import org.hibernate.annotations.UpdateTimestamp
import java.time.Instant
import java.util.Objects
import java.util.UUID

/**
 * 워크플로(논리적 컨테이너). 실제 그래프 내용은 불변 [FlowVersion] 들에 보관되고,
 * Flow 는 메타데이터와 "현재 버전 포인터"를 갖는다. (버전관리/롤백의 기반)
 */
@Entity
@Table(name = "flow", indexes = [jakarta.persistence.Index(name = "idx_flow_workspace", columnList = "workspace_id")])
class Flow {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "tenant_id", nullable = false)
    lateinit var tenantId: String
        private set

    @Column(nullable = false)
    lateinit var name: String

    @Column(columnDefinition = "text")
    var description: String? = null

    /** 현재 활성 버전 번호(없으면 0). */
    @Column(name = "current_version", nullable = false)
    var currentVersion: Int = 0

    @Column(nullable = false)
    var archived: Boolean = false

    /** 소속 폴더(없으면 미분류). */
    @Column(name = "folder_id")
    var folderId: UUID? = null

    /** 소속 워크스페이스(null = 공용 — 레거시 데이터 호환). */
    @Column(name = "workspace_id")
    var workspaceId: UUID? = null

    /** 낙관적 잠금 — 동시 편집 lost-update 방지(저장 충돌 시 409로 매핑). */
    @Version
    @Column(nullable = false)
    var version: Long = 0
        private set

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
        fun create(tenantId: String, name: String, description: String?): Flow {
            val f = Flow()
            f.id = UUID.randomUUID()
            f.tenantId = tenantId
            f.name = name
            f.description = description
            f.currentVersion = 0
            f.archived = false
            return f
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) {
            return true
        }
        if (other !is Flow) {
            return false
        }
        if (!this::id.isInitialized || !other::id.isInitialized) {
            return false
        }
        return id == other.id
    }

    override fun hashCode(): Int = Objects.hashCode(if (this::id.isInitialized) id else null)
}
