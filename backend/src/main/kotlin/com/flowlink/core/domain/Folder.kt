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

/** 워크플로 그룹핑 폴더(플랫). */
@Entity
@Table(name = "folder")
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
        fun create(tenantId: String, name: String): Folder {
            val f = Folder()
            f.id = UUID.randomUUID()
            f.tenantId = tenantId
            f.name = name
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
