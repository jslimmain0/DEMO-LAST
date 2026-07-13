package com.flowlink.core.repository

import com.flowlink.core.domain.AppSetting
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface AppSettingRepository : JpaRepository<AppSetting, UUID> {

    fun findByTenantIdAndKey(tenantId: String, key: String): Optional<AppSetting>
}
