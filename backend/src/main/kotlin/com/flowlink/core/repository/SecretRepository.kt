package com.flowlink.core.repository

import com.flowlink.core.domain.Secret
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface SecretRepository : JpaRepository<Secret, UUID> {

    fun findByTenantIdOrderByName(tenantId: String): List<Secret>

    fun findByTenantIdAndName(tenantId: String, name: String): Optional<Secret>
}
