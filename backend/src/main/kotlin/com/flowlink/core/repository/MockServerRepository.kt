package com.flowlink.core.repository

import com.flowlink.core.domain.MockServer
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface MockServerRepository : JpaRepository<MockServer, UUID> {

    fun findByTenantIdOrderByUpdatedAtDesc(tenantId: String): List<MockServer>

    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<MockServer>

    /** 서빙 경로 조회 — slug 는 팀 스코프 유니크(무인증 게이트웨이는 경로의 tenant 세그먼트로 조회). */
    fun findByTenantIdAndSlug(tenantId: String, slug: String): Optional<MockServer>

    fun existsByTenantIdAndSlug(tenantId: String, slug: String): Boolean
}
