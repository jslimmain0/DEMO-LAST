package com.flowlink.server.bridge

import com.flowlink.common.bridge.*
import org.springframework.web.bind.annotation.*
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.http.HttpStatus
import org.springframework.web.server.ResponseStatusException
import java.util.UUID

@RestController
@RequestMapping("/api/v1/desktop-bridge")
class DesktopBridgeController(private val service: DesktopBridgeService) {
    private fun user(): String {
        val jwt = SecurityContextHolder.getContext().authentication?.principal as? Jwt ?: throw ResponseStatusException(HttpStatus.UNAUTHORIZED, "회사 계정 인증이 필요합니다.")
        return "${jwt.getClaimAsString("tenant") ?: "default"}|${jwt.subject}"
    }
    @GetMapping("/status") fun status() = service.status(user())
    private fun device(): String? = (SecurityContextHolder.getContext().authentication?.principal as? Jwt)?.getClaimAsString("mcp_device")
    private fun <T> input(action: () -> T): T = try { action() } catch (ex: IllegalArgumentException) {
        throw com.flowlink.common.error.BadRequestException(ex.message ?: "개인 작업 요청 형식이 올바르지 않습니다.")
    }
    @PostMapping("/connect") fun connect(@RequestBody body: DesktopBridgeRegistration) = input { service.connect(user(), body.deviceId) }
    @PostMapping("/poll") fun poll(@RequestHeader("X-FlowLink-PC-Session") id: String, @RequestHeader("X-FlowLink-PC-Key") secret: String) = service.poll(user(), id, secret)
    @PostMapping("/complete") fun complete(@RequestHeader("X-FlowLink-PC-Session") id: String, @RequestHeader("X-FlowLink-PC-Key") secret: String, @RequestBody result: DesktopCommandResult) = input { service.complete(user(), id, secret, result) }
    @PostMapping("/requests") fun submit(@RequestBody command: DesktopCommand) = input { service.submit(user(), command, device()) }
    @GetMapping("/requests/{id}") fun result(@PathVariable id: UUID) = service.result(user(), id, device())
}
