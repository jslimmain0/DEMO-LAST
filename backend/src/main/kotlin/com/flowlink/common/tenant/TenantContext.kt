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

    /**
     * 워크플로우(flow/flow_version/folder)는 **전 사용자/팀 공통(전역 공유)** 이다 — 로그인 테넌트와 무관하게
     * 이 고정 테넌트로 저장·조회한다. (execution·mock·secret·assistant_session 은 여전히 getTenantId() 로 사용자별 격리.)
     * dev 모드의 DEFAULT_TENANT 와 같은 값이라 dev 데이터(기존 flow)도 그대로 공유 풀이 된다.
     */
    const val SHARED_FLOW_TENANT = DEFAULT_TENANT

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
