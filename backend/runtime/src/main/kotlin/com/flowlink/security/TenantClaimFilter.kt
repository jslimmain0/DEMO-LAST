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
 * GitHub 게스트 모드(자체 JWT 리소스 서버)일 때만 필터 체인에 추가된다.
 * 본 필터는 테넌트 식별자 전파만 담당한다(RLS 등 격리 구현체는 미도입).
 */
class TenantClaimFilter : OncePerRequestFilter() {

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse,
                                  chain: FilterChain) {
        try {
            val auth = SecurityContextHolder.getContext().authentication
            if (auth is JwtAuthenticationToken) {
                val tenant = auth.token.getClaimAsString(AppJwt.CLAIM_TENANT)
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
