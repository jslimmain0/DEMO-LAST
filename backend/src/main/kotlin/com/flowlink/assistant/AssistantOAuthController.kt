package com.flowlink.assistant

import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.net.URI

/**
 * 어시스턴트 OAuth 연결 API. 콜백만 무인증(provider 가 브라우저를 리다이렉트) — SecurityConfig 참조.
 * provider 설정(config)은 admin, 나머지는 editor.
 */
@RestController
@RequestMapping("/api/v1/assistant/oauth")
class AssistantOAuthController(private val service: AssistantOAuthService) {

    @GetMapping("/status")
    fun status(): OAuthStatus = service.status()

    @GetMapping("/config")
    fun config(): OAuthProviderConfig = service.providerConfig()

    @PutMapping("/config")
    fun updateConfig(@RequestBody req: OAuthProviderUpdate): OAuthProviderConfig {
        service.updateProvider(req)
        return service.providerConfig()
    }

    /**
     * authorize URL 발급 — 프론트가 이 URL 로 브라우저 이동. redirect_uri 오리진은 **요청 Origin/Referer 헤더**에서
     * 서버가 확정(클라 조작 방지). returnPath=로그인 후 돌아갈 앱 내 상대 경로(검증됨).
     */
    @GetMapping("/authorize")
    fun authorize(
        @RequestParam(required = false) returnPath: String?,
        request: HttpServletRequest,
    ): AuthorizeUrlResponse = AuthorizeUrlResponse(service.authorizeUrl(originOf(request), returnPath ?: "/flows"))

    /** 브라우저가 실제로 접속한 오리진 — Origin 헤더 우선, 없으면 Referer 의 오리진. */
    private fun originOf(request: HttpServletRequest): String {
        request.getHeader("Origin")?.takeIf { it.startsWith("http") }?.let { return it }
        request.getHeader("Referer")?.let { ref ->
            try { val u = java.net.URI(ref); if (u.scheme != null && u.host != null) return "${u.scheme}://${u.authority}" } catch (_: Exception) {}
        }
        // 폴백 — 요청 자체(프록시 뒤에선 부정확할 수 있으나 provider redirect_uri 화이트리스트가 최종 방어)
        val scheme = request.scheme; val host = request.serverName; val port = request.serverPort
        val portPart = if ((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) "" else ":$port"
        return "$scheme://$host$portPart"
    }

    /** provider 콜백(무인증) — code 교환 후 앱으로 302 리다이렉트. */
    @GetMapping("/callback")
    fun callback(
        @RequestParam(required = false) code: String?,
        @RequestParam(required = false) state: String?,
        @RequestParam(required = false) error: String?,
    ): ResponseEntity<Void> {
        val target = service.handleCallback(code, state, error)
        return ResponseEntity.status(HttpStatus.FOUND).location(URI.create(target)).build()
    }

    @PostMapping("/disconnect")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun disconnect() = service.disconnect()
}
