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
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.Base64
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

    /**
     * CSRF state → 진행 중 인가. 콜백은 무인증이라 state 로 테넌트/redirect_uri/PKCE verifier/복귀경로를 복원한다.
     * [redirectUri] 는 서버가 authorize 때 확정한 값(콜백에서 동일 값으로 교환 — 클라 조작 불가).
     */
    private data class Pending(
        val tenant: String,
        val redirectUri: String,
        val verifier: String, // PKCE code_verifier
        val returnPath: String,
        val at: Instant,
    )
    private val states = ConcurrentHashMap<String, Pending>()
    /** refresh 원자화용 락(테넌트별 토큰 갱신 경합/이중 발급 방지 — 갱신은 드물어 전역 락으로 충분). */
    private val refreshLock = Any()

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

    /**
     * authorize URL 생성 + state 저장. [origin] 은 **서버가 요청 Origin/Referer 헤더에서 확정**한 신뢰 오리진
     * (클라 파라미터 아님 — redirect_uri 조작/코드 가로채기 방지). [returnPath] 는 검증된 상대 복귀 경로.
     * PKCE(code_challenge S256) 포함.
     */
    fun authorizeUrl(origin: String, returnPath: String): String {
        val cfg = providerConfig()
        if (!cfg.configured) throw BadRequestException("OAuth provider 가 설정되지 않았습니다(관리자 설정 필요).")
        if (!origin.startsWith("http://") && !origin.startsWith("https://")) throw BadRequestException("오리진을 확인할 수 없습니다.")
        val redirect = redirectUri(origin)
        val verifier = randomToken() + randomToken() // 충분한 엔트로피(PKCE)
        val challenge = base64Url(sha256(verifier))
        val state = randomToken()
        states[state] = Pending(TenantContext.getTenantId(), redirect, verifier, sanitizeReturnPath(returnPath), Instant.now())
        cleanupStates()
        val sb = StringBuilder(cfg.authorizeUrl)
        sb.append(if (cfg.authorizeUrl.contains('?')) '&' else '?')
        sb.append("response_type=code")
        sb.append("&client_id=").append(enc(cfg.clientId))
        sb.append("&redirect_uri=").append(enc(redirect))
        sb.append("&state=").append(enc(state))
        sb.append("&code_challenge=").append(enc(challenge)).append("&code_challenge_method=S256")
        if (cfg.scope.isNotBlank()) sb.append("&scope=").append(enc(cfg.scope))
        return sb.toString()
    }

    /**
     * 콜백 처리(무인증) — state 검증 → 코드 교환 → 토큰 저장. **상대 경로**를 반환(오픈 리다이렉트 방지 —
     * 콜백은 이미 앱 오리진에 도착했으므로 상대 경로면 같은 오리진으로 안전하게 되돌아간다).
     */
    fun handleCallback(code: String?, state: String?, error: String?): String {
        val pending = state?.let { states.remove(it) }
            ?: return "/flows?ai=error" // state 불일치/만료 → 조용히 앱으로(CSRF/재생 방지, 단일 사용)
        val back = pending.returnPath
        if (error != null || code.isNullOrBlank()) return "$back?ai=error"
        TenantContext.setTenantId(pending.tenant)
        try {
            val cfg = providerConfig()
            // redirect_uri·code_verifier 는 authorize 때 서버가 확정한 값 그대로(클라 조작 불가)
            val tok = exchangeCode(cfg, code, pending.redirectUri, pending.verifier)
            saveToken(tok)
            return "$back?ai=connected"
        } catch (e: Exception) {
            log.warn("OAuth 콜백 실패: {}", e.message)
            return "$back?ai=error"
        } finally {
            TenantContext.clear()
        }
    }

    fun disconnect() = settings.put(K_TOKEN, null)

    /** 최근 refresh 실패 시각 — 짧게 네거티브 캐시(매 호출 30초 왕복 방지). */
    @Volatile private var lastRefreshFail: Long = 0

    /** LLM 호출용 유효 access_token(만료 시 refresh). 없으면 null. 요청/워커 스레드(테넌트 세팅됨)에서 호출. */
    fun accessToken(): String? {
        val tok = loadToken() ?: return null
        val now = Instant.now().toEpochMilli()
        if (tok.expiresAt == null || tok.expiresAt > now + 30_000) return tok.accessToken
        val rt = tok.refreshToken ?: return null
        if (now - lastRefreshFail < 60_000) return null // 방금 갱신 실패 — 재시도 억제(key/stub 폴백)
        // refresh 원자화 — 경합 시 재로드해 이미 갱신됐으면 그대로 사용(이중 발급/rotation 파손 방지)
        synchronized(refreshLock) {
            val cur = loadToken() ?: return null
            if (cur.expiresAt != null && cur.expiresAt > now + 30_000) return cur.accessToken
            val crt = cur.refreshToken ?: return null
            return try {
                val fresh = refresh(providerConfig(), crt)
                saveToken(fresh); lastRefreshFail = 0
                fresh.accessToken
            } catch (e: Exception) {
                log.warn("OAuth 토큰 갱신 실패: {}", e.message); lastRefreshFail = now; null
            }
        }
    }

    // --- 토큰 교환/갱신 ---

    private fun exchangeCode(cfg: OAuthProviderConfig, code: String, redirect: String, verifier: String): Token {
        val secret = clientSecret()
        val form = buildString {
            append("grant_type=authorization_code")
            append("&code=").append(enc(code))
            append("&redirect_uri=").append(enc(redirect))
            append("&client_id=").append(enc(cfg.clientId))
            append("&code_verifier=").append(enc(verifier)) // PKCE
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
        if (res.statusCode() >= 400) {
            log.warn("토큰 교환 비정상 응답 {}", res.statusCode())
            throw BadRequestException("토큰 교환 실패(상태 ${res.statusCode()})")
        }
        val root = mapper.readTree(res.body())
        val at = root.path("access_token").asText(null) ?: throw BadRequestException("응답에 access_token 이 없습니다.")
        val rt = root.path("refresh_token").asText(null)
        // expires_in 은 숫자 또는 문자열("3600") 둘 다 허용(asLong 가 문자열도 코어션)
        val ei = root.path("expires_in").asLong(0)
        val expiresAt = if (ei > 0) Instant.now().toEpochMilli() + ei * 1000 else null
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

    /** 복귀 경로는 반드시 앱 내 상대 경로 — 오픈 리다이렉트 방지(스킴/호스트/역슬래시 차단). */
    private fun sanitizeReturnPath(p: String?): String {
        val v = p?.trim().orEmpty()
        // '/path' 만 허용. '//host'·'/\host'·'http:' 등은 절대/프로토콜상대 → 거부하고 기본으로.
        if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || v.contains("://")) return "/flows"
        return v
    }

    private fun sha256(s: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(StandardCharsets.UTF_8))
    private fun base64Url(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    companion object {
        const val K_AUTHORIZE = "assistant.oauth.authorizeUrl"
        const val K_TOKEN_URL = "assistant.oauth.tokenUrl"
        const val K_CLIENT_ID = "assistant.oauth.clientId"
        const val K_CLIENT_SECRET = "assistant.oauth.clientSecret"
        const val K_SCOPE = "assistant.oauth.scope"
        const val K_TOKEN = "assistant.oauth.token"
    }
}
