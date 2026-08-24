package com.flowlink.notify

import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.repository.FlowRepository
import com.flowlink.settings.SettingsService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.UUID
import java.util.concurrent.Executors

/**
 * 실행 실패 알림 — 테넌트가 설정한 웹훅 URL(Slack/Teams incoming webhook 등)로 `{text}` JSON 을 발송.
 * 무인 실행(스케줄/웹훅)에서 실패를 즉시 통보하는 용도. 파이어&포겟(백그라운드), 실패해도 실행에 영향 없음.
 * ⚠ URL 은 admin 이 설정(RBAC)하므로 사내 URL 허용 — 스킴(http/https)만 검증(전체 SsrfGuard 미적용, 문서화된 트레이드오프).
 */
@Service
class NotificationService(
    private val settings: SettingsService,
    private val flowRepo: FlowRepository,
    private val json: JsonService,
) {
    private val log = LoggerFactory.getLogger(NotificationService::class.java)
    private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "flowlink-notify").apply { isDaemon = true } }
    private val http: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

    /** 실행 실패를 비동기로 알린다(설정된 URL 이 없으면 no-op). */
    fun notifyFailure(tenant: String, execId: UUID, flowId: UUID, error: String?) {
        exec.submit {
            TenantContext.setTenantId(tenant)
            try {
                val url = settings.notifyWebhookUrl()?.trim().orEmpty()
                if (url.isBlank()) return@submit
                val uri = try { URI.create(url) } catch (_: Exception) { return@submit }
                val scheme = uri.scheme?.lowercase()
                if (scheme != "http" && scheme != "https") { log.warn("알림 URL 스킴 거부: {}", scheme); return@submit }

                val flowName = flowRepo.findById(flowId).map { it.name }.orElse(flowId.toString())
                val text = "❌ FlowLink 실행 실패 — 워크플로 '$flowName'" +
                    (if (!error.isNullOrBlank()) ": $error" else "") + " (실행 $execId)"
                val payload = json.toJson(mapOf("text" to text, "flowId" to flowId.toString(), "executionId" to execId.toString(), "status" to "FAILED"))

                val req = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofSeconds(5))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(payload))
                    .build()
                val res = http.send(req, HttpResponse.BodyHandlers.discarding())
                if (res.statusCode() >= 300) log.warn("알림 발송 비정상 응답 {}", res.statusCode())
                else log.info("실패 알림 발송 완료: exec={} (응답 {})", execId, res.statusCode())
            } catch (e: Exception) {
                log.warn("실패 알림 발송 오류: {}", e.message)
            } finally {
                TenantContext.clear()
            }
        }
    }
}
