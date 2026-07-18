package com.flowlink.assistant

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.execution.config.ExecutionProperties
import com.flowlink.execution.engine.SsrfGuard
import com.flowlink.execution.engine.StateCrypto
import com.flowlink.settings.SettingsService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * GitHub Copilot 연결 — **디바이스 플로우**(Copilot 확장과 동일). 사용자가 github.com/login/device 에서 코드를 입력해
 * 인증하면 GitHub 토큰을 받아 저장하고, 채팅 시 그 토큰으로 **Copilot 토큰**을 발급받아 Copilot API 를 호출한다.
 * (Copilot 내부 엔드포인트는 비공식 — 확장이 쓰는 것과 동일. Copilot 구독 필요.)
 */
@Service
class AssistantOAuthService(
    private val settings: SettingsService,
    private val json: JsonService,
    private val ssrfGuard: SsrfGuard,
    props: ExecutionProperties,
) {
    private val log = LoggerFactory.getLogger(AssistantOAuthService::class.java)
    private val mapper: ObjectMapper = json.mapper()
    private val crypto = StateCrypto(props.stateSecret)
    private val http: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    private data class Pending(@Volatile var error: String?)
    /** 진행 중 디바이스 인증(tenant 단위). */
    private val pending = ConcurrentHashMap<String, Pending>()
    /** Copilot 토큰 캐시(tenant → (token, 만료 epoch ms)). GitHub 토큰에서 재발급. */
    private val copilotCache = ConcurrentHashMap<String, Pair<String, Long>>()
    private val copilotLock = Any()
    private val poolers = Executors.newCachedThreadPool { r -> Thread(r, "copilot-devicepoll").apply { isDaemon = true } }

    // --- 상태 ---

    fun status(): OAuthStatus {
        val tenant = TenantContext.getTenantId()
        val p = pending[tenant]
        return OAuthStatus(connected = githubToken() != null, pending = p != null, error = p?.error)
    }

    fun connected(): Boolean = githubToken() != null

    fun disconnect() {
        val tenant = TenantContext.getTenantId()
        settings.put(K_TOKEN, null)
        copilotCache.remove(tenant)
        pending.remove(tenant)
    }

    // --- 디바이스 플로우 ---

    /** 디바이스 코드 발급 + 백그라운드 폴링 시작. 사용자에게 코드/URL 을 돌려준다. */
    fun startDevice(): DeviceStart {
        val tenant = TenantContext.getTenantId()
        val body = "client_id=$COPILOT_CLIENT_ID&scope=" + enc("read:user")
        val root = postForm(DEVICE_CODE_URL, body, null)
        val deviceCode = root.path("device_code").asText(null) ?: throw BadRequestException("device_code 를 받지 못했습니다.")
        val userCode = root.path("user_code").asText("")
        val verify = root.path("verification_uri").asText("https://github.com/login/device")
        val expiresIn = root.path("expires_in").asInt(900)
        val interval = root.path("interval").asInt(5)
        pending[tenant] = Pending(null)
        val deadline = Instant.now().plusSeconds(expiresIn.toLong())
        poolers.submit { pollLoop(tenant, deviceCode, interval, deadline) }
        return DeviceStart(userCode, verify, expiresIn, interval)
    }

    private fun pollLoop(tenant: String, deviceCode: String, interval: Int, deadline: Instant) {
        TenantContext.setTenantId(tenant)
        var iv = interval.coerceAtLeast(1)
        try {
            while (Instant.now().isBefore(deadline) && pending.containsKey(tenant)) {
                try { Thread.sleep(iv * 1000L) } catch (e: InterruptedException) { return }
                val body = "client_id=$COPILOT_CLIENT_ID&device_code=" + enc(deviceCode) +
                    "&grant_type=" + enc("urn:ietf:params:oauth:grant-type:device_code")
                val root = try { postForm(TOKEN_URL, body, null) } catch (e: Exception) { log.debug("디바이스 폴 오류: {}", e.message); continue }
                val at = root.path("access_token").asText(null)
                if (!at.isNullOrBlank()) { saveGithubToken(at); pending.remove(tenant); return }
                when (root.path("error").asText("")) {
                    "authorization_pending" -> {}
                    "slow_down" -> iv += 5
                    "access_denied", "expired_token", "" -> { pending[tenant]?.error = root.path("error").asText("expired"); pending.remove(tenant); return }
                    else -> { pending[tenant]?.error = root.path("error").asText("error"); pending.remove(tenant); return }
                }
            }
            pending.remove(tenant)
        } finally { TenantContext.clear() }
    }

    // --- Copilot 토큰(채팅용 Bearer) ---

    /** Copilot API 호출용 Bearer — GitHub 토큰으로 Copilot 토큰을 발급받아 캐시(만료 전까지 재사용). 없으면 null. */
    fun copilotBearer(): String? {
        val gh = githubToken() ?: return null
        val tenant = TenantContext.getTenantId()
        val now = Instant.now().toEpochMilli()
        copilotCache[tenant]?.let { if (it.second > now + 30_000) return it.first }
        synchronized(copilotLock) {
            copilotCache[tenant]?.let { if (it.second > now + 30_000) return it.first }
            val root = try {
                getWithAuth(COPILOT_TOKEN_URL, "token $gh")
            } catch (e: Exception) { log.warn("Copilot 토큰 발급 실패: {}", e.message); return null }
            val token = root.path("token").asText(null) ?: return null
            val exp = if (root.path("expires_at").isNumber) root.path("expires_at").asLong() * 1000 else now + 25 * 60 * 1000
            copilotCache[tenant] = token to exp
            return token
        }
    }

    /** Copilot 채팅 엔드포인트 베이스 + 확장 헤더(확장이 쓰는 값과 동일). */
    fun copilotChatBase(): String = COPILOT_CHAT_BASE
    fun copilotHeaders(): Map<String, String> = mapOf(
        "Editor-Version" to EDITOR_VERSION,
        "Editor-Plugin-Version" to PLUGIN_VERSION,
        "Copilot-Integration-Id" to "vscode-chat",
        "User-Agent" to USER_AGENT,
    )
    fun copilotModel(): String = COPILOT_MODEL

    // --- 저장/HTTP ---

    private fun githubToken(): String? = settings.get(K_TOKEN)?.takeIf { it.isNotBlank() }?.let {
        try { crypto.decrypt(it) } catch (e: Exception) { log.warn("GitHub 토큰 복호화 실패: {}", e.message); null }
    }
    private fun saveGithubToken(t: String) = settings.put(K_TOKEN, crypto.encrypt(t))

    private fun postForm(url: String, form: String, auth: String?): com.fasterxml.jackson.databind.JsonNode {
        val uri = URI.create(url)
        try { ssrfGuard.check(uri) } catch (e: Exception) { throw BadRequestException("차단됨(SSRF): ${e.message}") }
        var b = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(20))
            .header("content-type", "application/x-www-form-urlencoded").header("accept", "application/json")
        if (auth != null) b = b.header("Authorization", auth)
        val res = http.send(b.POST(HttpRequest.BodyPublishers.ofString(form)).build(), HttpResponse.BodyHandlers.ofString())
        if (res.statusCode() >= 400) throw BadRequestException("GitHub 응답 ${res.statusCode()}")
        return mapper.readTree(res.body().ifBlank { "{}" })
    }

    private fun getWithAuth(url: String, auth: String): com.fasterxml.jackson.databind.JsonNode {
        val uri = URI.create(url)
        try { ssrfGuard.check(uri) } catch (e: Exception) { throw BadRequestException("차단됨(SSRF): ${e.message}") }
        val req = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(20))
            .header("Authorization", auth).header("accept", "application/json")
            .header("Editor-Version", EDITOR_VERSION).header("Editor-Plugin-Version", PLUGIN_VERSION)
            .header("User-Agent", USER_AGENT).GET().build()
        val res = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (res.statusCode() >= 400) throw BadRequestException("Copilot 토큰 응답 ${res.statusCode()}")
        return mapper.readTree(res.body().ifBlank { "{}" })
    }

    private fun enc(s: String): String = URLEncoder.encode(s, StandardCharsets.UTF_8)

    companion object {
        // GitHub Copilot(에디터 플러그인) 공개 OAuth client_id — 디바이스 플로우용.
        const val COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98"
        const val DEVICE_CODE_URL = "https://github.com/login/device/code"
        const val TOKEN_URL = "https://github.com/login/oauth/access_token"
        const val COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
        const val COPILOT_CHAT_BASE = "https://api.githubcopilot.com"
        const val COPILOT_MODEL = "gpt-4o"
        const val EDITOR_VERSION = "vscode/1.95.0"
        const val PLUGIN_VERSION = "copilot-chat/0.22.0"
        const val USER_AGENT = "GitHubCopilotChat/0.22.0"
        const val K_TOKEN = "assistant.oauth.token"
    }
}
