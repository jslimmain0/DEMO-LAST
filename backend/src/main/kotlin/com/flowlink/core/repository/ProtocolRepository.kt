package com.flowlink.core.repository

import com.flowlink.core.domain.Protocol
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface ProtocolRepository : JpaRepository<Protocol, UUID> {
    fun findByTenantIdOrderByNameAsc(tenantId: String): List<Protocol>
    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<Protocol>
    fun existsByTenantIdAndName(tenantId: String, name: String): Boolean
}
