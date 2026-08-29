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

/** 워크플로 그룹핑 폴더 — parent_id 로 중첩(트리) 가능(null = 루트). */
@Entity
@Table(name = "folder", indexes = [jakarta.persistence.Index(name = "idx_folder_workspace", columnList = "workspace_id")])
class Folder {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "tenant_id", nullable = false)
    lateinit var tenantId: String
        private set

    @Column(nullable = false)
    lateinit var name: String

    /** 상위 폴더(null = 루트). 생성 시에만 지정 — 이동 API 는 후속(사이클 생성 불가 보장). */
    @Column(name = "parent_id")
    var parentId: UUID? = null

    /** 소속 워크스페이스(null = 공용 — 레거시 데이터 호환). */
    @Column(name = "workspace_id")
    var workspaceId: UUID? = null

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
        @JvmOverloads
        fun create(tenantId: String, name: String, parentId: UUID? = null): Folder {
            val f = Folder()
            f.id = UUID.randomUUID()
            f.tenantId = tenantId
            f.name = name
            f.parentId = parentId
            return f
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) {
            return true
        }
        if (other !is Folder) {
            return false
        }
        if (!this::id.isInitialized || !other::id.isInitialized) {
            return false
        }
        return id == other.id
    }

    override fun hashCode(): Int = Objects.hashCode(if (this::id.isInitialized) id else null)
}
