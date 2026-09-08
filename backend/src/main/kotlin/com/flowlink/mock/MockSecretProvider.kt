package com.flowlink.mock

import com.flowlink.common.tenant.TenantContext
import com.flowlink.secret.SecretService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.util.concurrent.ConcurrentHashMap

/**
 * Mock 서빙용 시크릿 공급자 — `{{ 이름@secret }}` 를 풀기 위한 맵을 **테넌트 + 시크릿 환경(spec.environment)** 단위로
 * 10초 캐시한다(Transit/Vault 왕복을 요청마다 안 하게). 서빙 스레드(게이트웨이/TCP 리스너)에서 호출하며 테넌트를 직접 지정한다.
 * 조회 실패(Vault 다운 등)는 빈 맵 + WARN(Mock 은 계속 응답, 토큰만 빈 문자열). 환경 변수는 Mock 에 없다(시크릿만).
 */
@Component
class MockSecretProvider(private val secrets: SecretService) {

    private class Entry(val map: Map<String, String>, val at: Long)

    private val cache = ConcurrentHashMap<String, Entry>()
    private val log = LoggerFactory.getLogger(MockSecretProvider::class.java)

    fun secrets(tenantId: String, environment: String?): Map<String, String> {
        val env = environment?.trim().orEmpty()
        val key = "$tenantId|$env"
        val now = System.currentTimeMillis()
        cache[key]?.let { if (now - it.at < TTL_MS) return it.map }
        val loaded = load(tenantId, env)
        cache[key] = Entry(loaded, now)
        return loaded
    }

    /** 시크릿 저장 후 즉시 반영이 필요할 때 — 전체 캐시 비움. */
    fun invalidate() = cache.clear()

    private fun load(tenantId: String, env: String): Map<String, String> {
        val prev = TenantContext.getTenantId()
        TenantContext.setTenantId(tenantId)
        try {
            return try { secrets.activeSecrets(env.ifEmpty { null }) } catch (e: Exception) {
                log.warn("Mock 시크릿 조회 실패(tenant={}, env={}): {}", tenantId, env, e.message); emptyMap()
            }
        } finally {
            TenantContext.setTenantId(prev)
        }
    }

    companion object {
        const val TTL_MS = 10_000L
    }
}
