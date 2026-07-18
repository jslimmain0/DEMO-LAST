package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.hibernate.annotations.CreationTimestamp
import java.time.Instant
import java.util.Objects
import java.util.UUID

/**
 * 테넌트 스코프 시크릿 — Bearer/API 키 등. 값은 AES-GCM(StateCrypto)으로 암호화 저장하고,
 * 실행 시 `{{ 이름@secret }}` 로 주입하되 캡처 로그/DB 에는 마스킹(NodeRecorder)한다.
 * API 는 write-only(값은 조회 불가, 이름만).
 */
@Entity
@Table(name = "secret")
class Secret {

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

    @Column(name = "enc_value", columnDefinition = "text", nullable = false)
    lateinit var encValue: String

    // 환경(dev/staging/prod) 스코프. COMMON("*")=공통(전역). JPA nullable — H2 dev legacy 행의 NULL 관용(공통 취급).
    @Column(name = "environment", length = 120)
    var environment: String? = null
        private set

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    lateinit var createdAt: Instant
        private set

    companion object {
        const val COMMON = "*" // 공통(전역) 환경 센티넬 — NULL/빈 문자열 대신(3 DB 균일 + 유니크 정합)

        @JvmStatic
        fun create(tenantId: String, name: String, encValue: String, environment: String): Secret {
            val s = Secret()
            s.id = UUID.randomUUID()
            s.tenantId = tenantId
            s.name = name
            s.encValue = encValue
            s.environment = environment
            return s
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Secret) return false
        if (!this::id.isInitialized || !other::id.isInitialized) return false
        return id == other.id
    }

    override fun hashCode(): Int = Objects.hashCode(if (this::id.isInitialized) id else null)
}
