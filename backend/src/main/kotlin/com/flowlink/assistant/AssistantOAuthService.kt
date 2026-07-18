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
import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * 어시스턴트 OAuth 연결(GitHub Copilot 식) — authorization_code 플로우로 AI 제공자에 로그인해
 * access_token 을 받아 LLM 호출 자격으로 쓴다(관리자 API 키 붙여넣기 대신). 토큰은 AES-GCM 암호화 저장(테넌트 스코프).
 * provider 설정은 admin 이 설정에 저장. 만료 시 refresh_token 으로 갱신.
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
    private val rnd = SecureRandom()

    /** CSRF state → (tenant, origin, 생성시각). 콜백은 무인증이므로 state 로 테넌트를 복원한다. */
    private data class Pending(val tenant: String, val origin: String, val at: Instant)
    private val states = ConcurrentHashMap<String, Pending>()

    private data class Token(val accessToken: String, val refreshToken: String?, val expiresAt: Long?)

    // --- provider 설정(admin) ---

    fun providerConfig(): OAuthProviderConfig {
        val auth = settings.get(K_AUTHORIZE).orEmpty()
        val token = settings.get(K_TOKEN_URL).orEmpty()
        val cid = settings.get(K_CLIENT_ID).orEmpty()
        val hasSecret = !settings.get(K_CLIENT_SECRET).isNullOrBlank()
        return OAuthProviderConfig(auth, token, cid, settings.get(K_SCOPE).orEmpty(), hasSecret,
            configured = auth.isNotBlank() && token.isNotBlank() && cid.isNotBlank())
    }

    fun updateProvider(req: OAuthProviderUpdate) {
        req.authorizeUrl?.let { settings.put(K_AUTHORIZE, it.trim()) }
        req.tokenUrl?.let { settings.put(K_TOKEN_URL, it.trim()) }
        req.clientId?.let { settings.put(K_CLIENT_ID, it.trim()) }
        req.scope?.let { settings.put(K_SCOPE, it.trim()) }
        // clientSecret: null=변경 없음, ""=삭제, 그 외=암호화 저장
        req.clientSecret?.let { settings.put(K_CLIENT_SECRET, if (it.isBlank()) null else crypto.encrypt(it)) }
    }

    // --- 연결 상태 ---

    fun status(): OAuthStatus {
        val cfg = providerConfig()
        val tok = loadToken()
        return OAuthStatus(cfg.configured, tok != null, tok?.expiresAt)
    }

    fun connected(): Boolean = loadToken() != null

    // --- authorize / callback ---

    /** authorize URL 생성 + state 저장. [origin] = 브라우저 접속 오리진(redirect_uri 구성). */
    fun authorizeUrl(origin: String): String {
        val cfg = providerConfig()
        if (!cfg.configured) throw BadRequestException("OAuth provider 가 설정되지 않았습니다(관리자 설정 필요).")
        val state = randomToken()
        states[state] = Pending(TenantContext.getTenantId(), origin.trimEnd('/'), Instant.now())
        cleanupStates()
        val redirect = redirectUri(origin)
        val sb = StringBuilder(cfg.authorizeUrl)
        sb.append(if (cfg.authorizeUrl.contains('?')) '&' else '?')
        sb.append("response_type=code")
        sb.append("&client_id=").append(enc(cfg.clientId))
        sb.append("&redirect_uri=").append(enc(redirect))
        sb.append("&state=").append(enc(state))
        if (cfg.scope.isNotBlank()) sb.append("&scope=").append(enc(cfg.scope))
        return sb.toString()
    }

    /** 콜백 처리(무인증) — state 검증 → 코드 교환 → 토큰 저장. 성공 시 앱으로 돌아갈 URL 반환. */
    fun handleCallback(code: String?, state: String?, error: String?): String {
        val pending = state?.let { states.remove(it) }
            ?: return "/flows?ai=error" // state 불일치/만료 → 조용히 앱으로
        val backTo = pending.origin + "/flows"
        if (error != null || code.isNullOrBlank()) return "$backTo?ai=error"
        TenantContext.setTenantId(pending.tenant)
        try {
            val cfg = providerConfig()
            val tok = exchangeCode(cfg, code, redirectUri(pending.origin))
            saveToken(tok)
            return "$backTo?ai=connected"
        } catch (e: Exception) {
            log.warn("OAuth 콜백 실패: {}", e.message)
            return "$backTo?ai=error"
        } finally {
            TenantContext.clear()
        }
    }

    fun disconnect() = settings.put(K_TOKEN, null)

    /** LLM 호출용 유효 access_token(만료 시 refresh). 없으면 null. 요청/워커 스레드(테넌트 세팅됨)에서 호출. */
    fun accessToken(): String? {
        val tok = loadToken() ?: return null
        val now = Instant.now().toEpochMilli()
        if (tok.expiresAt == null || tok.expiresAt > now + 30_000) return tok.accessToken
        // 만료 임박 — refresh
        val rt = tok.refreshToken ?: return null
        return try {
            val cfg = providerConfig()
            val fresh = refresh(cfg, rt)
            saveToken(fresh)
            fresh.accessToken
        } catch (e: Exception) {
            log.warn("OAuth 토큰 갱신 실패: {}", e.message); null
        }
    }

    // --- 토큰 교환/갱신 ---

    private fun exchangeCode(cfg: OAuthProviderConfig, code: String, redirect: String): Token {
        val secret = clientSecret()
        val form = buildString {
            append("grant_type=authorization_code")
            append("&code=").append(enc(code))
            append("&redirect_uri=").append(enc(redirect))
            append("&client_id=").append(enc(cfg.clientId))
            if (!secret.isNullOrEmpty()) append("&client_secret=").append(enc(secret))
        }
        return postToken(cfg.tokenUrl, form)
    }

    private fun refresh(cfg: OAuthProviderConfig, refreshToken: String): Token {
        val secret = clientSecret()
        val form = buildString {
            append("grant_type=refresh_token")
            append("&refresh_token=").append(enc(refreshToken))
            append("&client_id=").append(enc(cfg.clientId))
            if (!secret.isNullOrEmpty()) append("&client_secret=").append(enc(secret))
        }
        val t = postToken(cfg.tokenUrl, form)
        // 일부 provider 는 refresh 응답에 refresh_token 을 안 주므로 기존 것 유지
        return if (t.refreshToken == null) t.copy(refreshToken = refreshToken) else t
    }

    private fun postToken(tokenUrl: String, form: String): Token {
        val uri = try { URI.create(tokenUrl) } catch (e: Exception) { throw BadRequestException("토큰 URL 이 올바르지 않습니다.") }
        try { ssrfGuard.check(uri) } catch (e: Exception) { throw BadRequestException("토큰 URL 차단됨(SSRF): ${e.message}") }
        val req = HttpRequest.newBuilder(uri)
            .timeout(Duration.ofSeconds(30))
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(form))
            .build()
        val res = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (res.statusCode() >= 400) throw BadRequestException("토큰 교환 실패 ${res.statusCode()}: ${res.body().take(200)}")
        val root = mapper.readTree(res.body())
        val at = root.path("access_token").asText(null) ?: throw BadRequestException("응답에 access_token 이 없습니다.")
        val rt = root.path("refresh_token").asText(null)
        val expiresAt = if (root.path("expires_in").isNumber) Instant.now().toEpochMilli() + root.path("expires_in").asLong() * 1000 else null
        return Token(at, rt, expiresAt)
    }

    // --- 저장 ---

    private fun clientSecret(): String? = settings.get(K_CLIENT_SECRET)?.takeIf { it.isNotBlank() }?.let { crypto.decrypt(it) }

    private fun loadToken(): Token? {
        val enc = settings.get(K_TOKEN)?.takeIf { it.isNotBlank() } ?: return null
        return try {
            val n = mapper.readTree(crypto.decrypt(enc))
            Token(n.path("access_token").asText(), n.path("refresh_token").asText(null),
                if (n.path("expires_at").isNumber) n.path("expires_at").asLong() else null)
        } catch (e: Exception) { log.warn("OAuth 토큰 복호화 실패: {}", e.message); null }
    }

    private fun saveToken(t: Token) {
        val obj = mapper.createObjectNode().put("access_token", t.accessToken)
        t.refreshToken?.let { obj.put("refresh_token", it) }
        t.expiresAt?.let { obj.put("expires_at", it) }
        settings.put(K_TOKEN, crypto.encrypt(mapper.writeValueAsString(obj)))
    }

    // --- 유틸 ---

    private fun redirectUri(origin: String): String = origin.trimEnd('/') + "/api/v1/assistant/oauth/callback"
    private fun enc(s: String): String = URLEncoder.encode(s, StandardCharsets.UTF_8)
    private fun randomToken(): String {
        val b = ByteArray(24); rnd.nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }
    private fun cleanupStates() {
        val cutoff = Instant.now().minus(Duration.ofMinutes(10))
        states.entries.removeIf { it.value.at.isBefore(cutoff) }
    }

    companion object {
        const val K_AUTHORIZE = "assistant.oauth.authorizeUrl"
        const val K_TOKEN_URL = "assistant.oauth.tokenUrl"
        const val K_CLIENT_ID = "assistant.oauth.clientId"
        const val K_CLIENT_SECRET = "assistant.oauth.clientSecret"
        const val K_SCOPE = "assistant.oauth.scope"
        const val K_TOKEN = "assistant.oauth.token"
    }
}
