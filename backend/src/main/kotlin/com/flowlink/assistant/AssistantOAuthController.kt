package com.flowlink.assistant

import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

/**
 * GitHub Copilot 연결 API — 디바이스 플로우(Copilot 확장과 동일). editor 이상.
 */
@RestController
@RequestMapping("/api/v1/assistant/oauth")
class AssistantOAuthController(private val service: AssistantOAuthService) {

    @GetMapping("/status")
    fun status(): OAuthStatus = service.status()

    /** 디바이스 코드 발급 — 프론트가 userCode 를 보여주고 verificationUri 를 열어 인증 대기. */
    @PostMapping("/device/start")
    fun deviceStart(): DeviceStart = service.startDevice()

    @PostMapping("/disconnect")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun disconnect() = service.disconnect()
}
