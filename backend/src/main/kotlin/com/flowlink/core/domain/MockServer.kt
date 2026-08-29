package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.Id
import jakarta.persistence.Table
import jakarta.persistence.UniqueConstraint
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
 * slug 는 **팀(테넌트) 스코프 유니크** — 서빙 경로는 `/mock/{tenant}/{slug}/…`,
 * default 테넌트는 레거시 `/mock/{slug}/…` 로도 서빙(하위호환, MockPathResolver).
 * 서빙은 무인증(외부 시스템 흉내), 관리 API 만 테넌트 스코프.
 *
 * `kind` 는 mock 유형 — **HTTP**(경로·응답·콜백)와 **TCP**(포트·고정길이 전문)를 나눠 생성. 편집기가 유형에 맞는
 * 섹션만 노출한다. **CUSTOM 은 레거시**(HTTP·TCP 둘 다 편집) — 기존 데이터 후방호환용으로 반드시 유지(제거 금지).
 */
@Entity
@Table(
    name = "mock_server",
    uniqueConstraints = [UniqueConstraint(name = "uq_mock_server_tenant_slug", columnNames = ["tenant_id", "slug"])]
)
class MockServer {

    // CUSTOM=레거시(둘 다), HTTP=경로/응답, TCP=소켓 전문. CUSTOM 은 기존 행 역직렬화 위해 절대 제거 금지.
    enum class Kind { CUSTOM, HTTP, TCP }

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "tenant_id", nullable = false)
    lateinit var tenantId: String
        private set

    @Column(nullable = false)
    lateinit var name: String

    /** 서빙 경로 조각 — 팀 스코프 유니크(tenant_id, slug), [a-z0-9-]{3,40}. */
    @Column(nullable = false, length = 64)
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

    /** 소속 워크스페이스(null=공용) — flow 와 동일 규약. 서빙(/mock/{slug})은 무인증 그대로. */
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
