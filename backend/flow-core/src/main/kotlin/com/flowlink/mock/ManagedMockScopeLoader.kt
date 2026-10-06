package com.flowlink.mock

import com.flowlink.common.tenant.TenantContext
import com.flowlink.environment.EnvironmentService
import com.flowlink.secret.SecretService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

@Component
class ManagedMockScopeLoader(private val secrets: SecretService, private val environments: EnvironmentService) : MockScopeLoader {
    private val log = LoggerFactory.getLogger(javaClass)
    override fun load(tenantId: String, environment: String, workspaceId: java.util.UUID?): MockSecretProvider.Scope {
        val prev = TenantContext.getTenantId()
        TenantContext.setTenantId(tenantId)
        try {
            val sec = try { secrets.activeSecrets(environment.ifEmpty { null }, workspaceId) } catch (e: Exception) { log.warn("시크릿 조회 실패(tenant={}, env={}): {}", tenantId, environment, e.message); emptyMap() }
            val vars = try { environments.vars(environment, workspaceId) } catch (e: Exception) { log.warn("환경 변수 조회 실패(tenant={}, env={}): {}", tenantId, environment, e.message); emptyMap() }
            return MockSecretProvider.Scope(sec, vars)
        } finally { TenantContext.setTenantId(prev) }
    }
}
