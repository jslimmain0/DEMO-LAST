package com.flowlink.security

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.execution.engine.SsrfGuard
import org.slf4j.LoggerFactory
import org.springframework.context.ApplicationEventPublisher
import org.springframework.stereotype.Service
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * GitHub 로그인(Copilot 과 동일한 디바이스 플로우) — 앱 로그인용. 사용자가 github.com/login/device 에서
 * 코드를 입력해 인증하면 GitHub 신원을 확인하고 [AppJwt] 로 앱 JWT 를 발급한다.
 * 프론트는 device/start → 코드 표시 → device/poll 로 완료를 감지해 JWT 를 받는다(무인증 경로).
 */
@Service
class GithubAuthService(
    private val props: AuthProperties,
    private val appJwt: AppJwt,
    private val ssrfGuard: SsrfGuard,
    private val events: ApplicationEventPublisher,
) {
    private val log = LoggerFactory.getLogger(GithubAuthService::class.java)
    private val mapper = ObjectMapper()
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
    private val pollers = Executors.newCachedThreadPool { r -> Thread(r, "gh-login-poll").apply { isDaemon = true } }

    private class Session(@Volatile var status: String = "pending", @Volatile var token: String? = null,
                          @Volatile var login: String? = null, @Volatile var error: String? = null,
                          val deadline: Instant)
    private val sessions = ConcurrentHashMap<String, Session>()

    data class DeviceStart(val sessionId: String, val userCode: String, val verificationUri: String, val intervalSec: Int, val expiresIn: Int)
    data class PollResult(val status: String, val token: String? = null, val login: String? = null, val error: String? = null)

    fun startDevice(): DeviceStart {
        // 무인증 엔드포인트 — 만료 세션 정리 후 동시 세션 상한으로 폴러 스레드/외부 폴링 폭주를 막는다.
        cleanup()
        if (sessions.size >= MAX_SESSIONS) {
            throw BadRequestException("동시 로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.")
        }
        val body = "client_id=${props.clientId}&scope=" + enc("read:user")
        val root = postForm(DEVICE_CODE_URL, body)
        val deviceCode = root.path("device_code").asText(null) ?: throw BadRequestException("device_code 를 받지 못했습니다.")
        val userCode = root.path("user_code").asText("")
        val verify = root.path("verification_uri").asText("https://github.com/login/device")
        val expiresIn = root.path("expires_in").asInt(900)
        val interval = root.path("interval").asInt(5)
        val sessionId = UUID.randomUUID().toString()
        val session = Session(deadline = Instant.now().plusSeconds(expiresIn.toLong()))
        sessions[sessionId] = session
        pollers.submit { pollLoop(sessionId, deviceCode, interval, session) }
        return DeviceStart(sessionId, userCode, verify, interval, expiresIn)
    }

    fun poll(sessionId: String): PollResult {
        val s = sessions[sessionId] ?: return PollResult("error", error = "세션이 없거나 만료됐습니다.")
        return PollResult(s.status, s.token, s.login, s.error)
    }

    private fun pollLoop(sessionId: String, deviceCode: String, interval: Int, s: Session) {
        var iv = interval.coerceAtLeast(1)
        try {
            while (Instant.now().isBefore(s.deadline) && s.status == "pending") {
                try { Thread.sleep(iv * 1000L) } catch (e: InterruptedException) { return }
                val body = "client_id=${props.clientId}&device_code=" + enc(deviceCode) +
                    "&grant_type=" + enc("urn:ietf:params:oauth:grant-type:device_code")
                val root = try { postForm(TOKEN_URL, body) } catch (e: Exception) { log.debug("로그인 폴 오류: {}", e.message); continue }
                val at = root.path("access_token").asText(null)
                if (!at.isNullOrBlank()) { complete(s, at); return }
                when (root.path("error").asText("")) {
                    "authorization_pending" -> {}
                    "slow_down" -> iv += 5
                    else -> { s.status = "error"; s.error = root.path("error").asText("로그인 실패"); return }
                }
            }
            if (s.status == "pending") { s.status = "error"; s.error = "만료됨" }
        } catch (e: Exception) { s.status = "error"; s.error = e.message ?: "오류" }
    }

    /** GitHub 토큰으로 신원 확인 → 화이트리스트 검사 → 앱 JWT 발급. */
    private fun complete(s: Session, ghToken: String) {
        try {
            val user = getWithAuth("https://api.github.com/user", "token $ghToken")
            val login = user.path("login").asText(null)
            if (login.isNullOrBlank()) {
                log.warn("GitHub 로그인 실패: 사용자 정보를 읽지 못했습니다")
                s.status = "error"; s.error = "GitHub 사용자 정보를 못 읽었습니다."; return
            }
            if (!props.allows(login)) {
                log.warn("GitHub 로그인 거부: '{}' 은 허용 목록(FLOWLINK_AUTH_ALLOWED_LOGINS)에 없습니다", login)
                s.status = "error"; s.error = "접근 권한이 없는 계정입니다: $login"; return
            }
            s.login = login
            s.token = appJwt.issue(login)
            s.status = "ready"
            log.info("GitHub 로그인 성공: {}", login)
            // 통합: 같은 GitHub 토큰을 어시스턴트 Copilot 연결로도 재사용(같은 계정·client·scope). 로그인은 이미 성공했으니
            // 이벤트 발행/구독 실패가 로그인을 막지 않도록 격리한다. Copilot client 로 로그인한 경우에만 채택(수신 측 판정).
            try {
                events.publishEvent(GithubLoginEvent(login, ghToken, TenantContext.DEFAULT_TENANT, props.clientId))
            } catch (e: Exception) {
                log.warn("Copilot 연결 통합 이벤트 발행 실패(로그인은 정상): {}", e.message)
            }
        } catch (e: Exception) {
            log.warn("GitHub 신원 확인 실패: {}", e.message ?: e.toString())
            s.status = "error"; s.error = "신원 확인 실패: ${e.message}"
        }
    }

    private fun cleanup() {
        val now = Instant.now()
        sessions.entries.removeIf { it.value.deadline.plusSeconds(120).isBefore(now) }
    }

    private fun postForm(url: String, form: String): JsonNode {
        val uri = URI.create(url)
        try { ssrfGuard.check(uri) } catch (e: Exception) { throw BadRequestException("차단됨(SSRF): ${e.message}") }
        val req = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(20))
            .header("content-type", "application/x-www-form-urlencoded").header("accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(form)).build()
        val res = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (res.statusCode() >= 400) throw BadRequestException("GitHub 응답 ${res.statusCode()}")
        return mapper.readTree(res.body().ifBlank { "{}" })
    }

    private fun getWithAuth(url: String, auth: String): JsonNode {
        val uri = URI.create(url)
        ssrfGuard.check(uri)
        val req = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(20))
            .header("Authorization", auth).header("accept", "application/json")
            .header("User-Agent", "FlowLink").GET().build()
        val res = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (res.statusCode() >= 400) throw BadRequestException("GitHub 응답 ${res.statusCode()}")
        return mapper.readTree(res.body().ifBlank { "{}" })
    }

    private fun enc(s: String) = URLEncoder.encode(s, StandardCharsets.UTF_8)

    companion object {
        const val DEVICE_CODE_URL = "https://github.com/login/device/code"
        const val TOKEN_URL = "https://github.com/login/oauth/access_token"
        /** 동시 진행 디바이스 로그인 세션 상한 — 무인증 device/start 남용으로 인한 폴러 스레드/외부 폴링 폭주 방지. */
        const val MAX_SESSIONS = 20
    }
}
