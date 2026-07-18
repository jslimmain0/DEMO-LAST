package com.flowlink.core.repository

import com.flowlink.core.domain.Secret
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import java.util.Optional
import java.util.UUID

interface SecretRepository : JpaRepository<Secret, UUID> {

    fun findByTenantIdOrderByEnvironmentAscNameAsc(tenantId: String): List<Secret>

    fun findByTenantIdAndEnvironmentAndName(tenantId: String, environment: String, name: String): Optional<Secret>

    /**
     * 레거시 NULL environment 행을 공통('*')으로 백필 — 마이그레이션 전 H2 dev 데이터 관용.
     * Flyway DB(PG/Oracle)는 DEFAULT '*' 라 0건(무해). "environment 는 기동 후 절대 null 아님" 불변식 확립.
     */
    @Modifying
    @Query("update Secret s set s.environment = :common where s.environment is null")
    fun backfillNullEnvironment(common: String): Int
}
