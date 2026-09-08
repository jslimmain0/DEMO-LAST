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

/**
 * 실행 환경(dev/staging/prod) + 변수 — 테넌트 스코프(팀 공유). 실행 시 활성 환경의 변수가 `{{ 키@env }}` 로 해석된다.
 * (이전엔 브라우저 localStorage 개인 스코프 — DB 로 옮겨 팀 공유·브라우저 무관.) 변수는 JSON 객체(varsJson).
 * 활성 환경 선택은 개인 취향이라 여전히 브라우저에 둔다.
 */
@Entity
@Table(name = "flowlink_environment", indexes = [Index(name = "idx_environment_tenant_name", columnList = "tenant_id, name", unique = true)])
class Environment {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "tenant_id", nullable = false, updatable = false)
    lateinit var tenantId: String
        private set

    @Column(nullable = false, length = 120)
    lateinit var name: String
        private set

    @Column(name = "vars_json", columnDefinition = "text", nullable = false)
    lateinit var varsJson: String

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    lateinit var createdAt: Instant
        private set

    @UpdateTimestamp
    @Column(name = "updated_at")
    var updatedAt: Instant? = null
        private set

    companion object {
        @JvmStatic
        fun create(tenantId: String, name: String, varsJson: String): Environment {
            val e = Environment()
            e.id = UUID.randomUUID()
            e.tenantId = tenantId
            e.name = name
            e.varsJson = varsJson
            return e
        }
    }
}
