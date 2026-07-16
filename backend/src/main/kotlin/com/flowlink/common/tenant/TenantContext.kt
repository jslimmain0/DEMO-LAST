package com.flowlink.common.tenant

/**
 * 요청 단위 테넌트 식별자 보관소(ThreadLocal).
 *
 * OIDC 모드(SaaS P1)에서는 [com.flowlink.security.TenantClaimFilter] 가 JWT 테넌트 클레임으로 채우고,
 * 비동기 워커 스레드(P2)에서는 ExecutionService 가 수동으로 set/clear 한다. dev 모드(issuer 미설정)는
 * 아래 기본 테넌트로 동작. 쿼리의 `tenant_id` 필터링(팀 데이터 격리)의 진입점. RLS(행 수준 보안)는 미도입.
 */
object TenantContext {

    /** dev 모드(인증 미설정) 기본 테넌트. */
    const val DEFAULT_TENANT = "default"

    private val CURRENT: ThreadLocal<String> = ThreadLocal.withInitial { DEFAULT_TENANT }

    @JvmStatic
    fun getTenantId(): String = CURRENT.get()

    @JvmStatic
    fun setTenantId(tenantId: String?) {
        CURRENT.set(if (tenantId == null || tenantId.isBlank()) DEFAULT_TENANT else tenantId)
    }

    @JvmStatic
    fun clear() {
        CURRENT.remove()
    }
}
