package com.flowlink.mcp

import com.fasterxml.jackson.databind.JsonNode
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException

@RestController
class McpOAuthController(private val oauth: McpOAuthService, private val clients: McpClientRepository) {
    @GetMapping("/mcp-consent", produces = [MediaType.TEXT_HTML_VALUE])
    fun consent(@RequestParam("client_id") clientId: String, @RequestParam state: String,
                @RequestParam scope: String, request: HttpServletRequest): ResponseEntity<String> {
        val client = clients.findByClientId(clientId)
            ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "등록된 클라이언트가 아닙니다")
        if (scope.split(' ').filter(String::isNotBlank).toSet() != setOf("flowlink"))
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "지원하지 않는 권한입니다")
        val login = request.userPrincipal?.name
            ?: throw ResponseStatusException(HttpStatus.UNAUTHORIZED, "로그인이 필요합니다")
        return ResponseEntity.ok().header("Cache-Control", "no-store").header("X-Frame-Options", "DENY")
            .body(McpConsentPage.render(client.clientName, login, clientId, state, request.contextPath))
    }
    @PostMapping("/register")
    fun register(@RequestBody body: JsonNode, request: HttpServletRequest) = ResponseEntity.status(HttpStatus.CREATED)
        .header("Cache-Control", "no-store").body(oauth.register(body, request))
    @GetMapping("/mcp-login", produces = [MediaType.TEXT_HTML_VALUE])
    fun login(request: HttpServletRequest, response: HttpServletResponse) = ResponseEntity.ok()
        .header("Cache-Control", "no-store").header("X-Frame-Options", "DENY").body(oauth.loginPage(request, response))
    @PostMapping("/login/start")
    fun start(@RequestParam tx: String, request: HttpServletRequest) = ResponseEntity.ok().header("Cache-Control", "no-store").body(oauth.start(tx, request))
    @GetMapping("/login/poll")
    fun poll(@RequestParam tx: String, request: HttpServletRequest, response: HttpServletResponse) = ResponseEntity.ok()
        .header("Cache-Control", "no-store").body(oauth.poll(tx, request, response))
    @GetMapping("/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp")
    fun resource(request: HttpServletRequest) = mapOf("resource" to oauth.origin(request) + "/mcp", "authorization_servers" to listOf(oauth.origin(request)),
        "bearer_methods_supported" to listOf("header"), "resource_name" to "FlowLink")
    @GetMapping("/.well-known/oauth-authorization-server/mcp")
    fun metadata(request: HttpServletRequest) = oauth.metadata(request)
}
