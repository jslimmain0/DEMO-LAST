package com.flowlink.core.repository

import com.flowlink.core.domain.Environment
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface EnvironmentRepository : JpaRepository<Environment, UUID> {

    fun findByTenantIdOrderByNameAsc(tenantId: String): List<Environment>

    fun findByTenantIdAndName(tenantId: String, name: String): Optional<Environment>
}
