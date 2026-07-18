package com.flowlink.assistant

import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

/**
 * 어시스턴트 GitHub OAuth 연결 API(팝업 로그인). 콜백만 무인증(GitHub 이 브라우저를 리다이렉트) — SecurityConfig 참조.
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

    /** GitHub authorize URL 발급 — 프론트가 팝업으로 연다. redirect_uri 오리진은 요청 헤더에서 서버가 확정. */
    @GetMapping("/authorize")
    fun authorize(request: HttpServletRequest): AuthorizeUrlResponse =
        AuthorizeUrlResponse(service.authorizeUrl(originOf(request)))

    /** GitHub 콜백(무인증, 팝업) — code 교환 후 팝업을 닫고 opener 에 결과 통지. */
    @GetMapping("/callback", produces = [MediaType.TEXT_HTML_VALUE])
    fun callback(
        @RequestParam(required = false) code: String?,
        @RequestParam(required = false) state: String?,
        @RequestParam(required = false) error: String?,
    ): String {
        val result = service.handleCallback(code, state, error) // "connected" | "error"
        // 팝업에서 opener 로 결과 postMessage(같은 오리진) 후 창 닫기. opener 없으면 앱으로 이동.
        return """<!doctype html><meta charset="utf-8"><title>AI 연결</title>
<body style="font-family:sans-serif;text-align:center;padding-top:60px;color:#444">
<p>${if (result == "connected") "GitHub 연결이 완료되었습니다. 이 창은 닫아도 됩니다." else "연결에 실패했습니다. 이 창을 닫고 다시 시도하세요."}</p>
<script>
  try { if (window.opener) window.opener.postMessage({ flowlink: 'ai-oauth', result: '$result' }, window.location.origin); } catch (e) {}
  setTimeout(function(){ try { window.close(); } catch(e){} if (!window.closed) window.location.replace('/flows?ai=$result'); }, 300);
</script></body>"""
    }

    @PostMapping("/disconnect")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun disconnect() = service.disconnect()

    /** 브라우저가 실제로 접속한 오리진 — Origin 헤더 우선, 없으면 Referer 의 오리진. */
    private fun originOf(request: HttpServletRequest): String {
        request.getHeader("Origin")?.takeIf { it.startsWith("http") }?.let { return it }
        request.getHeader("Referer")?.let { ref ->
            try { val u = java.net.URI(ref); if (u.scheme != null && u.host != null) return "${u.scheme}://${u.authority}" } catch (_: Exception) {}
        }
        val scheme = request.scheme; val host = request.serverName; val port = request.serverPort
        val portPart = if ((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) "" else ":$port"
        return "$scheme://$host$portPart"
    }
}
