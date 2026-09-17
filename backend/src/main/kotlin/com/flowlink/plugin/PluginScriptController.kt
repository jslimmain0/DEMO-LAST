package com.flowlink.plugin

import com.flowlink.plugin.script.FlApi
import com.flowlink.plugin.script.FlApiEntry
import com.flowlink.plugin.script.ScriptError
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import java.util.UUID

/** 스크립트 플러그인 API — 게이트는 서비스 레이어(승인 사용자 쓰기 · 관리자 승인). ScriptError 는 400 + {message, line, col}. */
@RestController
@RequestMapping("/api/v1/plugins")
class PluginScriptController(private val service: PluginScriptService) {
    /** fl.* 매니페스트 — 편집기 자동완성·MCP 가이드(비밀 없음, 공개). */
    @GetMapping("/api") fun api(): List<FlApiEntry> = FlApi.MANIFEST

    @GetMapping("/scripts") fun list(@RequestParam(required = false) status: String?): List<PluginScriptDtos.Summary> =
        service.list().let { l -> if (status.isNullOrBlank()) l else l.filter { it.status == status } }
    @GetMapping("/scripts/{id}") fun get(@PathVariable id: UUID) = service.get(id)
    @PostMapping("/scripts") @ResponseStatus(HttpStatus.CREATED) fun create(@RequestBody req: PluginScriptDtos.SaveRequest) = service.create(req)
    @PutMapping("/scripts/{id}") fun update(@PathVariable id: UUID, @RequestBody req: PluginScriptDtos.SaveRequest) = service.update(id, req)
    @PostMapping("/scripts/try") fun tryRun(@RequestBody req: PluginScriptDtos.TryRequest) = service.tryRun(req)
    @PutMapping("/scripts/{id}/sample") @ResponseStatus(HttpStatus.NO_CONTENT) fun sample(@PathVariable id: UUID, @RequestBody body: Map<String, Any?>) =
        service.saveSample(id, body["sampleJson"]?.toString())
    @PostMapping("/scripts/{id}/submit") fun submit(@PathVariable id: UUID) = service.submit(id)
    @PostMapping("/scripts/{id}/withdraw") fun withdraw(@PathVariable id: UUID) = service.withdraw(id)
    @PostMapping("/scripts/{id}/approve") fun approve(@PathVariable id: UUID) = service.approve(id)
    @PostMapping("/scripts/{id}/reject") fun reject(@PathVariable id: UUID, @RequestBody(required = false) req: PluginScriptDtos.ReviewRequest?) = service.reject(id, req?.note)
    @DeleteMapping("/scripts/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) fun delete(@PathVariable id: UUID) = service.delete(id)

    @ExceptionHandler(ScriptError::class)
    fun scriptError(e: ScriptError): ResponseEntity<PluginScriptDtos.ScriptErrorBody> =
        ResponseEntity.badRequest().body(PluginScriptDtos.ScriptErrorBody(e.message ?: "스크립트 오류", e.line, e.col))
}
