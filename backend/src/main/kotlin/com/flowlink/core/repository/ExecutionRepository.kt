package com.flowlink.core.repository

import com.flowlink.core.domain.Execution
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface ExecutionRepository : JpaRepository<Execution, UUID> {

    fun findByTenantIdOrderByStartedAtDesc(tenantId: String, pageable: Pageable): List<Execution>

    fun findByFlowIdOrderByStartedAtDesc(flowId: UUID, pageable: Pageable): List<Execution>

    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<Execution>
}
