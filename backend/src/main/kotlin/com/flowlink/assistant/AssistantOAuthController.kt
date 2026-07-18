package com.flowlink.assistant

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

    /** authorize URL 발급 — 프론트가 이 URL 로 브라우저 이동(팝업/리다이렉트). origin=브라우저 접속 오리진. */
    @GetMapping("/authorize")
    fun authorize(@RequestParam origin: String): AuthorizeUrlResponse =
        AuthorizeUrlResponse(service.authorizeUrl(origin))

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
