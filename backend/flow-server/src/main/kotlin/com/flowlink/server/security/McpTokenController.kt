package com.flowlink.server.security

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.web.bind.annotation.*
import org.springframework.web.server.ResponseStatusException

@RestController
@RequestMapping("/api/v1/auth/mcp-tokens")
class McpTokenController(private val tokens: McpTokenService) {
    data class IssueRequest(val deviceId: String, val clientId: String)
    private fun appToken(auth: JwtAuthenticationToken?): String = auth?.token?.tokenValue
        ?: throw ResponseStatusException(HttpStatus.UNAUTHORIZED, "Windows 앱의 중앙 로그인이 필요합니다")

    @PostMapping fun issue(auth: JwtAuthenticationToken?, @RequestBody request: IssueRequest): ResponseEntity<McpTokenResponse> = respond {
        require(request.clientId in setOf("vscode", "intellij")) { "지원하지 않는 MCP 클라이언트입니다" }
        tokens.issue(appToken(auth), request.deviceId, request.clientId)
    }
    @PostMapping("/{id}/refresh") fun refresh(auth: JwtAuthenticationToken?, @PathVariable id: String): ResponseEntity<McpTokenResponse> = respond {
        tokens.refresh(appToken(auth), id)
    }
    @DeleteMapping("/{id}") fun revoke(auth: JwtAuthenticationToken?, @PathVariable id: String): ResponseEntity<Void> {
        tokens.revoke(appToken(auth), id)
        return ResponseEntity.noContent().header("Cache-Control", "no-store").build()
    }
    @DeleteMapping fun revokeSession(auth: JwtAuthenticationToken?): ResponseEntity<Void> {
        tokens.revoke(appToken(auth))
        return ResponseEntity.noContent().header("Cache-Control", "no-store").build()
    }
    private fun respond(action: () -> McpTokenResponse): ResponseEntity<McpTokenResponse> = try {
        ResponseEntity.ok().header("Cache-Control", "no-store").body(action())
    } catch (ex: IllegalArgumentException) {
        throw ResponseStatusException(HttpStatus.BAD_REQUEST, ex.message)
    } catch (ex: org.springframework.security.oauth2.jwt.JwtException) {
        throw ResponseStatusException(HttpStatus.UNAUTHORIZED, "중앙 로그인 세션이 유효하지 않습니다")
    }
}
