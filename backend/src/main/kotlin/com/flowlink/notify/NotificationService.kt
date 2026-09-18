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
 * 알림 — 테넌트가 설정한 웹훅 URL(Slack/Teams incoming webhook 등)로 `{text, …}` JSON 을 발송. 실행 실패(무인 실행 통보)와
 * 플러그인 승인 흐름(승인 요청 → 관리자, 승인/반려 → 요청자). 파이어&포겟(백그라운드), 실패해도 본 처리에 영향 없음.
 * ⚠ URL 은 admin 이 설정(RBAC)하므로 사내 URL 허용 — 스킴(http/https)만 검증.
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
    fun notifyFailure(tenant: String, execId: UUID, flowId: UUID, error: String?) = async(tenant, "실패") {
        val flowName = flowRepo.findById(flowId).map { it.name }.orElse(flowId.toString())
        val text = "❌ FlowLink 실행 실패 — 워크플로 '$flowName'" + (if (!error.isNullOrBlank()) ": $error" else "") + " (실행 $execId)"
        post(mapOf("text" to text, "flowId" to flowId.toString(), "executionId" to execId.toString(), "status" to "FAILED"))
    }

    /** 플러그인 승인 흐름(PLUGIN_SUBMITTED · PLUGIN_APPROVED · PLUGIN_REJECTED) — 같은 웹훅으로 `{text, event, pluginId, scriptId}`. */
    fun notifyPlugin(tenant: String, event: String, text: String, pluginId: String, scriptId: UUID) = async(tenant, "플러그인") {
        post(mapOf("text" to text, "event" to event, "pluginId" to pluginId, "scriptId" to scriptId.toString()))
    }

    private fun async(tenant: String, what: String, body: () -> Unit) {
        exec.submit {
            TenantContext.setTenantId(tenant)
            try { body() } catch (e: Exception) { log.warn("{} 알림 발송 오류: {}", what, e.message) } finally { TenantContext.clear() }
        }
    }

    /** 테넌트 웹훅으로 POST(설정된 URL 없으면 no-op). 알림 스레드에서만(TenantContext 필요). */
    private fun post(payload: Map<String, Any?>) {
        val url = settings.notifyWebhookUrl()?.trim().orEmpty()
        if (url.isBlank()) return
        val uri = try { URI.create(url) } catch (_: Exception) { return }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") { log.warn("알림 URL 스킴 거부: {}", scheme); return }
        val req = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5)).header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(json.toJson(payload))).build()
        val res = http.send(req, HttpResponse.BodyHandlers.discarding())
        if (res.statusCode() >= 300) log.warn("알림 발송 비정상 응답 {}", res.statusCode())
    }
}
