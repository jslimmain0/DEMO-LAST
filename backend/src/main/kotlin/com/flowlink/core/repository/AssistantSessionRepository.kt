package com.flowlink.core.repository

import com.flowlink.core.domain.AssistantSession
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface AssistantSessionRepository : JpaRepository<AssistantSession, UUID> {

    /** 목록 — 최근 수정순. 사용자(tenant + username) 스코프. */
    fun findByTenantIdAndUsernameOrderByUpdatedAtDesc(tenantId: String, username: String): List<AssistantSession>

    /** 소유권 확인 포함 단건 조회(교차 사용자/테넌트 접근 차단). */
    fun findByIdAndTenantIdAndUsername(id: UUID, tenantId: String, username: String): Optional<AssistantSession>
}
