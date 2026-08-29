package com.flowlink.core.repository

import com.flowlink.core.domain.MockServer
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.util.Optional
import java.util.UUID

interface MockServerRepository : JpaRepository<MockServer, UUID> {

    /** 워크스페이스 삭제 시 안의 mock 이관 — 유령(관리 불가·서빙 지속) 방지. to=삭제 실행자 개인 ws, null=공용 폴백. */
    @Modifying
    @Query("update MockServer m set m.workspaceId = :to where m.workspaceId = :from")
    fun reassignWorkspace(@Param("from") from: UUID, @Param("to") to: UUID?): Int

    fun findByTenantIdOrderByUpdatedAtDesc(tenantId: String): List<MockServer>

    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<MockServer>

    /** 서빙 경로 조회 — slug 는 팀 스코프 유니크(무인증 게이트웨이는 경로의 tenant 세그먼트로 조회). */
    fun findByTenantIdAndSlug(tenantId: String, slug: String): Optional<MockServer>

    fun existsByTenantIdAndSlug(tenantId: String, slug: String): Boolean
}
