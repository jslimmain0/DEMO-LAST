package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.hibernate.annotations.UpdateTimestamp
import java.time.Instant
import java.util.Objects
import java.util.UUID

/** 앱 설정(키-값) — 콜백 수신 주소(relay base) 등 화면에서 저장/수정하는 런타임 설정. 테넌트 스코프. */
@Entity
@Table(name = "app_setting")
class AppSetting {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "tenant_id", nullable = false)
    lateinit var tenantId: String
        private set

    @Column(name = "setting_key", nullable = false)
    lateinit var key: String
        private set

    // text — 스킬(플로우 조각) JSON 등 긴 값 저장. Flyway DB 는 이미 text/clob, H2 ddl-auto 도 이 정의로 무제한.
    @Column(name = "setting_value", columnDefinition = "text")
    var value: String? = null

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    lateinit var updatedAt: Instant
        private set

    companion object {
        @JvmStatic
        fun create(tenantId: String, key: String, value: String?): AppSetting {
            val s = AppSetting()
            s.id = UUID.randomUUID()
            s.tenantId = tenantId
            s.key = key
            s.value = value
            return s
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) {
            return true
        }
        if (other !is AppSetting) {
            return false
        }
        if (!this::id.isInitialized || !other::id.isInitialized) {
            return false
        }
        return id == other.id
    }

    override fun hashCode(): Int = Objects.hashCode(if (this::id.isInitialized) id else null)
}
