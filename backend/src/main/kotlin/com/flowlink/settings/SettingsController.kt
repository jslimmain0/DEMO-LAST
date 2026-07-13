package com.flowlink.settings

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * 런타임 설정 API — 콜백 수신 주소(relay base).
 * value = 저장된 오버라이드(null 이면 자동), effective = 지금 실행하면 실제로 쓰일 값.
 */
@RestController
@RequestMapping("/api/v1/settings")
class SettingsController(
    private val settings: SettingsService,
    private val resolver: RelayBaseResolver,
) {

    data class RelaySetting(val value: String?, val effective: String, val auto: String?)

    data class SaveRelayRequest(val value: String?)

    @GetMapping("/relay")
    fun relay(): RelaySetting = current()

    @PutMapping("/relay")
    fun saveRelay(@RequestBody req: SaveRelayRequest): RelaySetting {
        settings.put(SettingsService.KEY_RELAY_BASE, req.value)
        return current()
    }

    private fun current(): RelaySetting =
        RelaySetting(settings.relayBaseUrl(), resolver.resolve(), resolver.requestOrigin())
}
