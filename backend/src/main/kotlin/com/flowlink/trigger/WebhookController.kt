package com.flowlink.trigger

import com.fasterxml.jackson.databind.JsonNode
import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RestController

/**
 * 인바운드 웹훅 — 외부 시스템이 무인증으로 부르는 실행 트리거(POST /hooks/{token}).
 * 토큰은 추측 불가한 비밀값(테스트 도구·사내망 전제). 본문(JSON object)은 실행 input 으로 주입된다.
 * 전체 예외를 가드해 500 대신 JSON 상태로 마감.
 */
@RestController
class WebhookController(private val service: TriggerService) {

    private val log = LoggerFactory.getLogger(WebhookController::class.java)

    @PostMapping("/hooks/{token}")
    fun fire(
        @PathVariable token: String,
        @RequestBody(required = false) body: JsonNode?,
    ): ResponseEntity<Map<String, Any?>> {
        return try {
            // claim(트랜잭션: lastRunAt 영속) → runFire(비트랜잭션: Execution 즉시 커밋 후 워커 제출)
            val spec = service.claimWebhookFire(token, body)
                ?: return ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "unknown or disabled webhook"))
            val execId = service.runFire(spec, com.flowlink.core.domain.TriggerType.WEBHOOK)
            ResponseEntity.accepted().body(mapOf("executionId" to execId.toString(), "status" to "RUNNING"))
        } catch (e: Exception) {
            log.debug("웹훅 발화 실패 {}: {}", token, e.message)
            ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "unknown or disabled webhook"))
        }
    }
}
