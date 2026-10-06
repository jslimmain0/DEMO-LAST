package com.flowlink.mock

import com.flowlink.common.tenant.TenantContext
import com.flowlink.common.error.BadRequestException
import com.flowlink.environment.EnvironmentService
import com.flowlink.secret.SecretService
import org.springframework.stereotype.Component
import org.springframework.http.HttpStatus
import org.springframework.web.server.ResponseStatusException

@Component
class ManagedMockScopeLoader(private val secrets: SecretService, private val environments: EnvironmentService) : MockScopeLoader {
    override fun load(tenantId: String, environment: String, workspaceId: java.util.UUID?): MockSecretProvider.Scope {
        val prev = TenantContext.getTenantId()
        TenantContext.setTenantId(tenantId)
        try {
            if (!environments.exists(environment, workspaceId)) throw BadRequestException("선택한 환경이 없습니다: $environment")
            return try {
                MockSecretProvider.Scope(secrets.activeSecrets(environment.ifEmpty { null }, workspaceId), environments.vars(environment, workspaceId))
            } catch (_: Exception) {
                throw ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "환경·시크릿을 불러오지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.")
            }
        } finally { TenantContext.setTenantId(prev) }
    }
}
