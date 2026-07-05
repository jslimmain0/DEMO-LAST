package com.flowlink.common.tenant

/**
 * 요청 단위 테넌트 식별자 보관소(1단계 골격).
 *
 * 현재는 단일 기본 테넌트로 동작하며, 후속 Phase에서 인증 토큰(OIDC claim)/서브도메인 기반으로
 * 채워 넣는다. 멀티테넌시 격리(행 수준 보안·데이터 분리)의 진입점 역할을 한다.
 */
object TenantContext {

    /** 인증·멀티테넌시 도입 전까지 사용할 기본 테넌트. */
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
