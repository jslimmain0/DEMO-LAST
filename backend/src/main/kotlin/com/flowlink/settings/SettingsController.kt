package com.flowlink.settings

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * 런타임 설정 API — 콜백 수신 주소(relay base).
 * value = 저장된 오버라이드(null 이면 자동), effective = 지금 실행하면 실제로 쓰일 값.
 * 쓰기는 **관리자만**(github/dev 모드 서비스 게이트 — 게스트가 relay base 를 자기 서버로 바꿔
 * 콜백을 탈취하거나 알림 웹훅을 훔쳐보던 구멍 봉인. OIDC 모드의 admin URL 규칙과 동일 의미).
 */
@RestController
@RequestMapping("/api/v1/settings")
class SettingsController(
    private val settings: SettingsService,
    private val resolver: RelayBaseResolver,
    private val workspace: com.flowlink.workspace.WorkspaceService,
) {

    private fun requireAdmin() {
        if (!workspace.isAdmin(workspace.currentUsername())) {
            throw com.flowlink.common.error.ForbiddenException("설정 변경은 관리자만 가능합니다.")
        }
    }

    data class RelaySetting(val value: String?, val effective: String, val auto: String?)

    data class SaveRelayRequest(val value: String?)

    @GetMapping("/relay")
    fun relay(): RelaySetting = current()

    @PutMapping("/relay")
    fun saveRelay(@RequestBody req: SaveRelayRequest): RelaySetting {
        requireAdmin()
        settings.put(SettingsService.KEY_RELAY_BASE, req.value)
        return current()
    }

    // 실행 실패 알림 웹훅(Slack/Teams incoming webhook URL). 빈 값 저장 = 알림 끄기.
    data class NotifySetting(val value: String?)

    @GetMapping("/notify")
    fun notify(): NotifySetting =
        // 웹훅 URL 자체가 비밀값(아는 사람은 그 채널로 임의 메시지 발송 가능) — 비관리자에겐 마스킹(null).
        // 403 대신 null 인 이유: ⚙ 설정 다이얼로그는 모두에게 열리는 화면이라 조회 실패가 UI 를 깨지 않게.
        if (workspace.isAdmin(workspace.currentUsername())) NotifySetting(settings.notifyWebhookUrl()) else NotifySetting(null)

    @PutMapping("/notify")
    fun saveNotify(@RequestBody req: NotifySetting): NotifySetting {
        requireAdmin()
        settings.put(SettingsService.KEY_NOTIFY_WEBHOOK, req.value)
        return NotifySetting(settings.notifyWebhookUrl())
    }

    private fun current(): RelaySetting =
        RelaySetting(settings.relayBaseUrl(), resolver.resolve(), resolver.requestOrigin())
}
