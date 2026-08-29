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
class AssistantOAuthController(
    private val service: AssistantOAuthService,
    private val workspace: com.flowlink.workspace.WorkspaceService,
) {

    /** 가입 승인 게이트 — 승인 전(PENDING)엔 Copilot 연결/모델 변경 불가(AI 자체가 승인 후). */
    private fun requireApproved() {
        if (!workspace.isApproved(workspace.currentUsername())) {
            throw com.flowlink.common.error.ForbiddenException("가입 승인 대기 중입니다 — 관리자가 승인하면 AI 를 쓸 수 있습니다.")
        }
    }

    @GetMapping("/status")
    fun status(): OAuthStatus = service.status()

    /** VS Code 확장 수준 종합 정보 — 계정·요금제·쿼터 사용량(프리미엄 요청 등). */
    @GetMapping("/info")
    fun info(): CopilotInfo = service.copilotInfo()

    /** 사용 가능한 Copilot 채팅 모델 + 현재 선택. */
    @GetMapping("/models")
    fun models(): Map<String, Any> = mapOf("models" to service.availableModels(), "current" to service.copilotModel())

    /** 채팅 모델 선택 저장 — 전역 설정이라 승인 사용자만 + 목록 화이트리스트 검증. */
    @PutMapping("/model")
    fun setModel(@RequestBody req: Map<String, String>): Map<String, Any> {
        requireApproved()
        req["model"]?.let { m ->
            val allowed = service.availableModels()
            if (allowed.isNotEmpty() && allowed.none { it["id"] == m }) {
                throw com.flowlink.common.error.BadRequestException("지원하지 않는 모델입니다: $m")
            }
            service.setModel(m)
        }
        return mapOf("current" to service.copilotModel())
    }

    /** 디바이스 코드 발급 — 승인 전엔 연결 자체를 막아 헛수고(연결 후 첫 채팅 403) 방지. */
    @PostMapping("/device/start")
    fun deviceStart(): DeviceStart { requireApproved(); return service.startDevice() }

    @PostMapping("/disconnect")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun disconnect() = service.disconnect()
}
