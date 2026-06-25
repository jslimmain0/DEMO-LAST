package com.flowlink.common.tenant;

/**
 * 요청 단위 테넌트 식별자 보관소(1단계 골격).
 *
 * <p>현재는 단일 기본 테넌트로 동작하며, 후속 Phase에서 인증 토큰(OIDC claim)/서브도메인 기반으로
 * 채워 넣는다. 멀티테넌시 격리(행 수준 보안·데이터 분리)의 진입점 역할을 한다.
 */
public final class TenantContext {

    /** 인증·멀티테넌시 도입 전까지 사용할 기본 테넌트. */
    public static final String DEFAULT_TENANT = "default";

    private static final ThreadLocal<String> CURRENT = ThreadLocal.withInitial(() -> DEFAULT_TENANT);

    private TenantContext() {
    }

    public static String getTenantId() {
        return CURRENT.get();
    }

    public static void setTenantId(String tenantId) {
        CURRENT.set(tenantId == null || tenantId.isBlank() ? DEFAULT_TENANT : tenantId);
    }

    public static void clear() {
        CURRENT.remove();
    }
}
