package com.flowlink.security

import com.flowlink.common.tenant.TenantContext
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.web.filter.OncePerRequestFilter

/**
 * 인증된 JWT 의 테넌트 클레임을 [TenantContext] 에 주입한다(멀티테넌시 격리 진입점).
 *
 * OIDC 리소스 서버가 활성일 때만 필터 체인에 추가된다. RLS 등 격리 구현체는 후속 Phase
 * (타깃 시장 확정 후)이며, 본 필터는 테넌트 식별자 전파만 담당한다.
 */
class TenantClaimFilter(private val tenantClaim: String) : OncePerRequestFilter() {

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse,
                                  chain: FilterChain) {
        try {
            val auth = SecurityContextHolder.getContext().authentication
            if (auth is JwtAuthenticationToken) {
                val tenant = auth.token.getClaimAsString(tenantClaim)
                if (tenant != null && !tenant.isBlank()) {
                    TenantContext.setTenantId(tenant)
                }
            }
            chain.doFilter(request, response)
        } finally {
            TenantContext.clear()
        }
    }
}
