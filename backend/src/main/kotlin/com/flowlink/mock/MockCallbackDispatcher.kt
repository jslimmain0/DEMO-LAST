package com.flowlink.mock

import com.flowlink.execution.engine.SsrfGuard
import com.flowlink.mock.MockHttp.FiredCallback
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * mock 의 콜백(웹훅) 발사기 — 승인노티/입금노티 패턴.
 * 응답 반환 후 비동기로 발사하고, retryUntilOk 면 응답 본문이 "OK" 가 아닐 때 2초 간격 최대 3회 재발송
 * (PG 노티 "OK 못 받으면 재발송" 규약의 축소판). 발사 대상 URL 은 SsrfGuard 를 통과해야 한다
 * (로컬 프로파일은 loopback 허용 → relay 콜백 가능).
 */
@Component
class MockCallbackDispatcher(private val ssrf: SsrfGuard) {

    private val exec: ScheduledExecutorService = Executors.newScheduledThreadPool(2) { r ->
        val t = Thread(r, "mock-callback")
        t.isDaemon = true
        t
    }
    private val client: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build()

    fun fire(cb: FiredCallback?) {
        if (cb == null || cb.url.isBlank()) {
            return
        }
        schedule(cb, 1, cb.afterMs.toLong())
    }

    private fun schedule(cb: FiredCallback, attempt: Int, delayMs: Long) {
        exec.schedule({ this.attempt(cb, attempt) }, Math.max(0L, delayMs), TimeUnit.MILLISECONDS)
    }

    private fun attempt(cb: FiredCallback, attempt: Int) {
        try {
            val uri = URI.create(cb.url)
            ssrf.check(uri)
            val b = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", cb.contentType)
            val req = when (cb.method) {
                "GET" -> b.GET().build()
                else -> b.method(
                    cb.method,
                    HttpRequest.BodyPublishers.ofString(cb.body ?: "", StandardCharsets.UTF_8)
                ).build()
            }
            val res = client.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
            val okAck = res.body() != null && res.body().trim() == "OK"
            log.info(
                "[mock-callback] {} {} → {} (시도 {}/{}, ack={})",
                cb.method, cb.url, res.statusCode(), attempt, MAX_ATTEMPTS, okAck
            )
            if (cb.retryUntilOk && !okAck && attempt < MAX_ATTEMPTS) {
                schedule(cb, attempt + 1, RETRY_INTERVAL_MS)
            }
        } catch (e: Exception) {
            log.warn(
                "[mock-callback] 발사 실패({}): {} — {}", attempt, cb.url,
                if (e.message == null) e.toString() else e.message
            )
            if (cb.retryUntilOk && attempt < MAX_ATTEMPTS) {
                schedule(cb, attempt + 1, RETRY_INTERVAL_MS)
            }
        }
    }

    companion object {
        private val log = LoggerFactory.getLogger(MockCallbackDispatcher::class.java)
        private const val MAX_ATTEMPTS = 3
        private const val RETRY_INTERVAL_MS = 2_000L
    }
}
