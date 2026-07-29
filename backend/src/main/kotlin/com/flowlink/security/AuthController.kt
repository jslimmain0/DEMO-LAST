package com.flowlink.security

import com.flowlink.common.tenant.TenantContext
import org.springframework.beans.factory.ObjectProvider
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.jwt.JwtDecoder
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
 * - `GET /auth/me` (github 게스트 모드·dev 모드는 무인증도 허용): 현재 사용자·팀·역할.
 *   인증된 요청은 JWT 클레임을 쓰고, 비인증 요청은 github 게스트 모드에서 "guest", dev 모드에서 "dev" 전권 가짜 사용자를 반환한다.
 * - `POST /auth/github/device/start` + `GET /auth/github/device/poll` (public): GitHub 디바이스 로그인.
 *   Copilot 과 동일한 device flow — 완료 시 앱 JWT 를 돌려준다.
 */
@RestController
@RequestMapping("/api/v1/auth")
class AuthController(
    private val authProps: AuthProperties,
    private val githubAuth: GithubAuthService,
    private val jwtDecoder: ObjectProvider<JwtDecoder>,
) {

    data class AuthConfigResponse(val enabled: Boolean, val mode: String)
    data class MeResponse(val username: String, val tenant: String, val roles: List<String>)

    @GetMapping("/config")
    fun config(): AuthConfigResponse {
        // github > oidc(issuer-uri 로 JwtDecoder 자동등록) > none(dev). oidc 는 SPA 셀프 로그인이 없어 외부 토큰이 필요하다.
        val mode = when {
            authProps.githubEnabled -> "github"
            jwtDecoder.ifAvailable != null -> "oidc"
            else -> "none"
        }
        return AuthConfigResponse(enabled = mode != "none", mode = mode)
    }

    @GetMapping("/me")
    fun me(): MeResponse {
        val auth = SecurityContextHolder.getContext().authentication
        if (auth is JwtAuthenticationToken) {
            val roles = auth.authorities.map { it.authority.removePrefix("ROLE_") }
            return MeResponse(auth.name, TenantContext.getTenantId(), roles)
        }
        // 비인증: github 게스트 모드는 "guest", dev 모드는 "dev" — 양쪽 다 전권 가짜 사용자(프론트 게이팅 단일 경로)
        val fallback = if (authProps.githubEnabled) "guest" else "dev"
        return MeResponse(fallback, TenantContext.DEFAULT_TENANT, listOf("admin", "editor", "platform-admin"))
    }

    @PostMapping("/github/device/start")
    fun deviceStart(): GithubAuthService.DeviceStart = githubAuth.startDevice()

    @GetMapping("/github/device/poll")
    fun devicePoll(@RequestParam session: String): GithubAuthService.PollResult = githubAuth.poll(session)
}
