package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.hibernate.annotations.CreationTimestamp
import org.hibernate.annotations.UpdateTimestamp
import java.time.Instant
import java.util.Objects
import java.util.UUID

/**
 * Mock 서버 — 워크플로가 호출할 가짜 대상 시스템을 사용자가 정의·서빙하는 1급 리소스.
 * 저장하면 즉시 `/mock/{slug}/` 이하로 서빙된다(별도 프로세스 없음).
 *
 * 라우트/규칙/응답 템플릿을 spec_json 으로 정의한다(전부 사용자 정의 커스텀 목).
 * slug 는 서빙 URL 경로라서 **전역 유니크**(테넌트 무관). 서빙은 무인증(외부 시스템 흉내),
 * 관리 API 만 테넌트 스코프.
 *
 * `kind` 는 향후 프리셋 확장 여지를 위해 남긴 컬럼으로, 현재는 CUSTOM 하나뿐이다.
 */
@Entity
@Table(name = "mock_server")
class MockServer {

    enum class Kind { CUSTOM }

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "tenant_id", nullable = false)
    lateinit var tenantId: String
        private set

    @Column(nullable = false)
    lateinit var name: String

    /** 서빙 경로 조각(/mock/{slug}/…) — 전역 유니크, [a-z0-9-]{3,40}. */
    @Column(nullable = false, unique = true, length = 64)
    lateinit var slug: String
        private set

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    lateinit var kind: Kind
        private set

    @Column(name = "enabled", nullable = false)
    var isEnabled: Boolean = false

    /** { routes: [...] } — 사용자 정의 라우트 규칙(JSON). */
    @Column(name = "spec_json", columnDefinition = "text")
    var specJson: String? = null

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
        fun create(tenantId: String, name: String, slug: String, kind: Kind, specJson: String?): MockServer {
            val m = MockServer()
            m.id = UUID.randomUUID()
            m.tenantId = tenantId
            m.name = name
            m.slug = slug
            m.kind = kind
            m.isEnabled = true
            m.specJson = specJson
            return m
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) {
            return true
        }
        if (other !is MockServer) {
            return false
        }
        if (!this::id.isInitialized || !other::id.isInitialized) {
            return false
        }
        return id == other.id
    }

    override fun hashCode(): Int = Objects.hashCode(if (this::id.isInitialized) id else null)
}
