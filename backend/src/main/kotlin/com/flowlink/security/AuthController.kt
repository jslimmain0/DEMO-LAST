package com.flowlink.security

import com.flowlink.common.tenant.TenantContext
import org.springframework.beans.factory.annotation.Value
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
 * - `GET /auth/config` (public): 인증 모드 발견 — "github"(GitHub 로그인) | "none"(dev). `mcpPort` 는 옆에 뜬 MCP HTTP 서버 포트
 *   (env `FLOWLINK_MCP_PORT`, scripts/start.sh 가 jar 와 Node 양쪽에 같은 값을 준다) — 설정 화면이 접속 안내에 쓴다. 미설정이면 null.
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
    @Value("\${FLOWLINK_MCP_PORT:}") private val mcpPort: String,
) {

    data class AuthConfigResponse(val enabled: Boolean, val mode: String, val mcpPort: Int? = null)
    data class MeResponse(val username: String, val tenant: String, val roles: List<String>)

    @GetMapping("/config")
    fun config(): AuthConfigResponse {
        val mode = if (authProps.githubEnabled) "github" else "none"
        return AuthConfigResponse(enabled = mode != "none", mode = mode, mcpPort = mcpPort.trim().toIntOrNull()?.takeIf { it > 0 })
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
