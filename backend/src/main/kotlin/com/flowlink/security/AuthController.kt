package com.flowlink.security

import com.flowlink.common.tenant.TenantContext
import org.springframework.beans.factory.annotation.Value
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * 인증 부트스트랩 API.
 *
 * - `GET /auth/config` (public): 프론트(SPA)가 env 없이 인증 모드를 발견 — enabled=false 면
 *   로그인 없이 동작(dev 모드), true 면 issuer 로 OIDC PKCE 로그인.
 * - `GET /me` (인증): 현재 사용자 이름·팀(테넌트)·역할 — 프론트 UI 게이팅(viewer 읽기전용 등) 소스.
 *   dev 모드에선 전권(admin/editor/platform-admin) 가짜 사용자를 반환해 프론트 게이팅 경로를 단일화한다.
 */
@RestController
@RequestMapping("/api/v1/auth")
class AuthController(
    private val props: SecurityProperties,
    @Value("\${spring.security.oauth2.resourceserver.jwt.issuer-uri:}") private val issuerUri: String,
) {

    data class AuthConfigResponse(val enabled: Boolean, val issuer: String?, val clientId: String)

    data class MeResponse(val username: String, val tenant: String, val roles: List<String>)

    @GetMapping("/config")
    fun config(): AuthConfigResponse {
        val enabled = issuerUri.isNotBlank()
        return AuthConfigResponse(enabled, if (enabled) issuerUri else null, props.clientId)
    }

    @GetMapping("/me")
    fun me(): MeResponse {
        val auth = SecurityContextHolder.getContext().authentication
        if (auth is JwtAuthenticationToken) {
            val roles = auth.authorities.map { it.authority.removePrefix("ROLE_") }
            return MeResponse(auth.name, TenantContext.getTenantId(), roles)
        }
        // dev 모드(permitAll): 전권 가짜 사용자 — viewer 게이팅이 걸리지 않게.
        return MeResponse("dev", TenantContext.DEFAULT_TENANT, listOf("admin", "editor", "platform-admin"))
    }
}
