package com.flowlink.security

import com.flowlink.common.tenant.TenantContext
import com.flowlink.common.host.LocalRuntimeSession
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * 서버·개인 호스트의 인증 모드와 현재 사용자 조회.
 *
 * - `GET /auth/config` (public): 인증 모드와 같은 서버의 중앙 `/mcp` 주소.
 *   개인 호스트는 MCP 주소를 제공하지 않으며 연결된 회사 서버에서 발견한다.
 * - `GET /auth/me` (github 게스트 모드·dev 모드는 무인증도 허용): 현재 사용자·팀·역할.
 *   인증된 요청은 JWT 클레임을 쓰고, 비인증 요청은 github 게스트 모드에서 "guest", dev 모드에서 "dev" 전권 가짜 사용자를 반환한다.
 * 서버의 GitHub 로그인 발급 API는 별도의 GithubLoginController가 제공한다.
 */
@RestController
@RequestMapping("/api/v1/auth")
class AuthController(
    private val authProps: AuthProperties,
    @Value("\${FLOWLINK_PUBLIC_URL:}") private val publicUrl: String,
    @Value("\${FLOWLINK_PUBLIC_MCP_URL:}") private val publicMcpUrl: String,
    private val desktop: ObjectProvider<LocalRuntimeSession>,
    @Value("\${flowlink.runtime.name:서버}") private val runtimeName: String,
) {

    data class RuntimeInfo(val kind: String, val name: String, val deviceId: String?)
    data class AuthConfigResponse(val enabled: Boolean, val mode: String, val mcpPort: Int? = null, val runtime: RuntimeInfo? = null, val mcpUrl: String? = null)
    data class MeResponse(val username: String, val tenant: String, val roles: List<String>)

    @GetMapping("/config")
    fun config(req: jakarta.servlet.http.HttpServletRequest): AuthConfigResponse {
        val mode = if (authProps.githubEnabled) "github" else "none"
        val local = desktop.getIfAvailable()
        val base = publicUrl.trim().trimEnd('/').ifBlank { "${req.scheme}://${req.serverName}:${req.serverPort}${req.contextPath}" }
        val endpoint = if (local == null) publicMcpUrl.trim().ifBlank { "$base/mcp" } else null
        val port = endpoint?.let { java.net.URI(it).let { uri -> if (uri.port > 0) uri.port else if (uri.scheme == "https") 443 else 80 } }
        return AuthConfigResponse(enabled = mode != "none", mode = mode,
            mcpPort = port, mcpUrl = endpoint,
            runtime = RuntimeInfo(if (local == null) "server" else "local", runtimeName, local?.deviceId))
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

}
