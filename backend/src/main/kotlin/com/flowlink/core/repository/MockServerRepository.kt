package com.flowlink.core.repository

import com.flowlink.core.domain.MockServer
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface MockServerRepository : JpaRepository<MockServer, UUID> {

    fun findByTenantIdOrderByUpdatedAtDesc(tenantId: String): List<MockServer>

    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<MockServer>

    /** 서빙 경로 조회 — slug 는 전역 유니크라 테넌트 무관(무인증 게이트웨이용). */
    fun findBySlug(slug: String): Optional<MockServer>

    fun existsBySlug(slug: String): Boolean
}
