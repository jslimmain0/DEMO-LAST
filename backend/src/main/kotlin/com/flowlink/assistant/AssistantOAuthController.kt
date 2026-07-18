package com.flowlink.assistant

import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
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

    /** VS Code 확장 수준 종합 정보 — 계정·요금제·쿼터 사용량(프리미엄 요청 등). */
    @GetMapping("/info")
    fun info(): CopilotInfo = service.copilotInfo()

    /** 사용 가능한 Copilot 채팅 모델 + 현재 선택. */
    @GetMapping("/models")
    fun models(): Map<String, Any> = mapOf("models" to service.availableModels(), "current" to service.copilotModel())

    /** 채팅 모델 선택 저장. */
    @PutMapping("/model")
    fun setModel(@RequestBody req: Map<String, String>): Map<String, Any> {
        req["model"]?.let { service.setModel(it) }
        return mapOf("current" to service.copilotModel())
    }

    /** 디바이스 코드 발급 — 프론트가 userCode 를 보여주고 verificationUri 를 열어 인증 대기. */
    @PostMapping("/device/start")
    fun deviceStart(): DeviceStart = service.startDevice()

    @PostMapping("/disconnect")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun disconnect() = service.disconnect()
}
