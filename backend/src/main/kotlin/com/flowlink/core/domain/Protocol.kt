package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Index
import jakarta.persistence.Table
import org.hibernate.annotations.CreationTimestamp
import org.hibernate.annotations.UpdateTimestamp
import java.time.Instant
import java.util.UUID

/** 고정길이 전문 프로토콜(필드 스키마) — 테넌트 스코프, 이름 유니크. TCP 노드·TCP Mock 이 id 로 참조. */
@Entity
@Table(name = "flowlink_protocol", indexes = [Index(name = "idx_protocol_tenant_name", columnList = "tenant_id, name", unique = true)])
class Protocol {
    @Id @Column(nullable = false, updatable = false) lateinit var id: UUID; private set
    @Column(name = "tenant_id", nullable = false, updatable = false) lateinit var tenantId: String; private set
    @Column(nullable = false, length = 120) lateinit var name: String
    @Column(name = "spec_json", columnDefinition = "text", nullable = false) lateinit var specJson: String
    @CreationTimestamp @Column(name = "created_at", nullable = false, updatable = false) lateinit var createdAt: Instant; private set
    @UpdateTimestamp @Column(name = "updated_at") var updatedAt: Instant? = null; private set

    companion object {
        @JvmStatic fun create(tenantId: String, name: String, specJson: String): Protocol =
            Protocol().also { it.id = UUID.randomUUID(); it.tenantId = tenantId; it.name = name; it.specJson = specJson }
    }
}
