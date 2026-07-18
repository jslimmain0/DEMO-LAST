package com.flowlink.security

import com.flowlink.common.tenant.TenantContext
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/**
 * 인증 부트스트랩 + GitHub 로그인 API.
 *
 * - `GET /auth/config` (public): 인증 모드 발견 — "github"(GitHub 로그인) | "oidc"(레거시 issuer) | "none"(dev).
 * - `GET /auth/me` (인증): 현재 사용자·팀·역할. dev 모드는 전권 가짜 사용자.
 * - `POST /auth/github/device/start` + `GET /auth/github/device/poll` (public): GitHub 디바이스 로그인.
 *   Copilot 과 동일한 device flow — 완료 시 앱 JWT 를 돌려준다.
 */
@RestController
@RequestMapping("/api/v1/auth")
class AuthController(
    private val props: SecurityProperties,
    private val authProps: AuthProperties,
    private val githubAuth: GithubAuthService,
) {

    data class AuthConfigResponse(val enabled: Boolean, val mode: String, val clientId: String)
    data class MeResponse(val username: String, val tenant: String, val roles: List<String>)

    @GetMapping("/config")
    fun config(): AuthConfigResponse {
        val mode = if (authProps.githubEnabled) "github" else "none"
        return AuthConfigResponse(enabled = authProps.githubEnabled, mode = mode, clientId = props.clientId)
    }

    @GetMapping("/me")
    fun me(): MeResponse {
        val auth = SecurityContextHolder.getContext().authentication
        if (auth is JwtAuthenticationToken) {
            val roles = auth.authorities.map { it.authority.removePrefix("ROLE_") }
            return MeResponse(auth.name, TenantContext.getTenantId(), roles)
        }
        // dev 모드(permitAll): 전권 가짜 사용자
        return MeResponse("dev", TenantContext.DEFAULT_TENANT, listOf("admin", "editor", "platform-admin"))
    }

    @PostMapping("/github/device/start")
    fun deviceStart(): GithubAuthService.DeviceStart = githubAuth.startDevice()

    @GetMapping("/github/device/poll")
    fun devicePoll(@RequestParam session: String): GithubAuthService.PollResult = githubAuth.poll(session)
}
