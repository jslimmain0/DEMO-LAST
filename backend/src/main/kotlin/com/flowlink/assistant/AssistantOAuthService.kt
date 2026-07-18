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
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
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
    /** 진행 중 디바이스 인증(tenant:user 단위). */
    private val pending = ConcurrentHashMap<String, Pending>()
    /** Copilot 토큰 캐시(tenant:user → (token, 만료 epoch ms)). GitHub 토큰에서 재발급. */
    private val copilotCache = ConcurrentHashMap<String, Pair<String, Long>>()
    private val copilotLock = Any()
    private val poolers = Executors.newCachedThreadPool { r -> Thread(r, "copilot-devicepoll").apply { isDaemon = true } }

    // --- 스코프(사용자별) — Copilot 연결은 tenant + 로그인 사용자 단위. OIDC 는 각자 자기 GitHub 로 연결. dev 는 단일 "dev". ---

    /** 현재 로그인 사용자명 — OIDC 는 JWT preferred_username(=auth.name), dev(무인증)는 "dev". */
    private fun currentUser(): String {
        val auth = SecurityContextHolder.getContext().authentication
        return if (auth is JwtAuthenticationToken) auth.name else DEV_USER
    }
    private fun scopeKey(tenant: String, user: String): String = "$tenant::$user"
    private fun scope(): String = scopeKey(TenantContext.getTenantId(), currentUser())
    private fun tokenKey(user: String): String = "$K_TOKEN:$user" // 설정은 TenantContext 로 tenant 스코프 + 키에 user 접미사

    // --- 상태 ---

    fun status(): OAuthStatus {
        val p = pending[scope()]
        return OAuthStatus(connected = githubToken() != null, pending = p != null, error = p?.error)
    }

    fun connected(): Boolean = githubToken() != null

    fun disconnect() {
        val user = currentUser()
        settings.put(tokenKey(user), null)
        if (user == DEV_USER) settings.put(K_TOKEN, null) // 레거시(사용자별 분리 이전) dev 토큰도 정리
        val s = scope()
        copilotCache.remove(s)
        infoCache.remove(s)
        pending.remove(s)
    }

    // --- 디바이스 플로우 ---

    /** 디바이스 코드 발급 + 백그라운드 폴링 시작. 사용자에게 코드/URL 을 돌려준다. */
    fun startDevice(): DeviceStart {
        val tenant = TenantContext.getTenantId()
        val user = currentUser() // 요청 스레드에서 캡처 — 폴 스레드엔 SecurityContext 가 없다
        val body = "client_id=$COPILOT_CLIENT_ID&scope=" + enc("read:user")
        val root = postForm(DEVICE_CODE_URL, body, null)
        val deviceCode = root.path("device_code").asText(null) ?: throw BadRequestException("device_code 를 받지 못했습니다.")
        val userCode = root.path("user_code").asText("")
        val verify = root.path("verification_uri").asText("https://github.com/login/device")
        val expiresIn = root.path("expires_in").asInt(900)
        val interval = root.path("interval").asInt(5)
        pending[scopeKey(tenant, user)] = Pending(null)
        val deadline = Instant.now().plusSeconds(expiresIn.toLong())
        poolers.submit { pollLoop(tenant, user, deviceCode, interval, deadline) }
        return DeviceStart(userCode, verify, expiresIn, interval)
    }

    private fun pollLoop(tenant: String, user: String, deviceCode: String, interval: Int, deadline: Instant) {
        TenantContext.setTenantId(tenant)
        val sc = scopeKey(tenant, user)
        var iv = interval.coerceAtLeast(1)
        try {
            while (Instant.now().isBefore(deadline) && pending.containsKey(sc)) {
                try { Thread.sleep(iv * 1000L) } catch (e: InterruptedException) { return }
                val body = "client_id=$COPILOT_CLIENT_ID&device_code=" + enc(deviceCode) +
                    "&grant_type=" + enc("urn:ietf:params:oauth:grant-type:device_code")
                val root = try { postForm(TOKEN_URL, body, null) } catch (e: Exception) { log.debug("디바이스 폴 오류: {}", e.message); continue }
                val at = root.path("access_token").asText(null)
                if (!at.isNullOrBlank()) { saveGithubToken(user, at); pending.remove(sc); return }
                when (root.path("error").asText("")) {
                    "authorization_pending" -> {}
                    "slow_down" -> iv += 5
                    "access_denied", "expired_token", "" -> { pending[sc]?.error = root.path("error").asText("expired"); pending.remove(sc); return }
                    else -> { pending[sc]?.error = root.path("error").asText("error"); pending.remove(sc); return }
                }
            }
            pending.remove(sc)
        } finally { TenantContext.clear() }
    }

    // --- VS Code 확장 수준 종합 정보(계정·요금제·쿼터 사용량) ---

    /** info 캐시(tenant:user → (info, 만료 epoch ms)). GitHub 를 매 폴링마다 때리지 않게 60초 캐시. */
    private val infoCache = ConcurrentHashMap<String, Pair<CopilotInfo, Long>>()

    fun copilotInfo(): CopilotInfo {
        if (githubToken() == null) return CopilotInfo(false, null, null, null, null, false, false, null, emptyList(), copilotModel(), null)
        val s = scope()
        val now = Instant.now().toEpochMilli()
        infoCache[s]?.let { if (it.second > now) return it.first.copy(currentModel = copilotModel()) }
        val info = buildInfo()
        infoCache[s] = info to (now + 60_000)
        return info
    }

    private fun buildInfo(): CopilotInfo {
        val gh = githubToken() ?: return CopilotInfo(false, null, null, null, null, false, false, null, emptyList(), copilotModel(), null)
        var login: String? = null
        var avatar: String? = null
        try {
            val u = getRaw("https://api.github.com/user", "token $gh")
            login = u.path("login").asText(null); avatar = u.path("avatar_url").asText(null)
        } catch (e: Exception) { log.debug("GitHub /user 실패: {}", e.message) }

        var plan: String? = null; var sku: String? = null; var chat = false; var agent = false; var reset: String? = null
        val quotas = mutableListOf<QuotaSnapshot>()
        try {
            val ci = getRaw("https://api.github.com/copilot_internal/user", "token $gh")
            plan = ci.path("copilot_plan").asText(null)
            sku = ci.path("access_type_sku").asText(null)
            chat = ci.path("chat_enabled").asBoolean(false)
            agent = ci.path("is_mcp_enabled").asBoolean(false)
            reset = ci.path("quota_reset_date").asText(null)
            val snaps = ci.path("quota_snapshots")
            for (id in listOf("premium_interactions", "chat", "completions")) {
                val s = snaps.path(id)
                if (s.isMissingNode || s.isNull) continue
                quotas.add(QuotaSnapshot(
                    id = id,
                    label = quotaLabel(id),
                    unlimited = s.path("unlimited").asBoolean(false),
                    percentRemaining = s.path("percent_remaining").asDouble(0.0),
                    remaining = s.path("remaining").asDouble(0.0),
                    entitlement = s.path("entitlement").asDouble(0.0),
                    used = s.path("credits_used").asDouble(s.path("used").asDouble(0.0)),
                    overagePermitted = s.path("overage_permitted").asBoolean(false),
                ))
            }
        } catch (e: Exception) { log.debug("Copilot /copilot_internal/user 실패: {}", e.message) }

        try { copilotBearer() } catch (e: Exception) { /* 만료 표시는 부가 정보 — 실패해도 무시 */ }
        val exp = copilotCache[scope()]?.second?.let { it / 1000 }
        return CopilotInfo(
            connected = true, login = login, avatarUrl = avatar, plan = plan, sku = sku,
            chatEnabled = chat, agentEnabled = agent, quotaResetDate = reset, quotas = quotas,
            currentModel = copilotModel(), tokenExpiresAt = exp,
            error = if (login == null && plan == null) "정보를 불러오지 못했습니다." else null,
        )
    }

    private fun quotaLabel(id: String): String = when (id) {
        "premium_interactions" -> "프리미엄 요청"
        "chat" -> "채팅 (포함 모델)"
        "completions" -> "자동완성 (포함 모델)"
        else -> id
    }

    /** 인증 GET → JsonNode(4xx 는 예외). copilot_internal 계열은 확장 헤더도 부착. */
    private fun getRaw(url: String, auth: String): com.fasterxml.jackson.databind.JsonNode {
        val uri = URI.create(url)
        ssrfGuard.check(uri)
        var b = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(20)).header("Authorization", auth).header("accept", "application/json")
        copilotHeaders().forEach { (k, v) -> b = b.header(k, v) }
        val res = http.send(b.GET().build(), HttpResponse.BodyHandlers.ofString())
        if (res.statusCode() >= 400) throw BadRequestException("GitHub 응답 ${res.statusCode()}")
        return mapper.readTree(res.body().ifBlank { "{}" })
    }

    // --- Copilot 토큰(채팅용 Bearer) ---

    /** Copilot API 호출용 Bearer — GitHub 토큰으로 Copilot 토큰을 발급받아 캐시(만료 전까지 재사용). 없으면 null. */
    fun copilotBearer(): String? {
        val gh = githubToken() ?: return null
        val s = scope()
        val now = Instant.now().toEpochMilli()
        copilotCache[s]?.let { if (it.second > now + 30_000) return it.first }
        synchronized(copilotLock) {
            copilotCache[s]?.let { if (it.second > now + 30_000) return it.first }
            val root = try {
                getWithAuth(COPILOT_TOKEN_URL, "token $gh")
            } catch (e: Exception) { log.warn("Copilot 토큰 발급 실패: {}", e.message); return null }
            val token = root.path("token").asText(null) ?: return null
            val exp = if (root.path("expires_at").isNumber) root.path("expires_at").asLong() * 1000 else now + 25 * 60 * 1000
            copilotCache[s] = token to exp
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

    /** 선택된 채팅 모델(설정) — 없으면 기본. */
    fun copilotModel(): String = settings.get(K_MODEL)?.takeIf { it.isNotBlank() } ?: DEFAULT_MODEL
    fun setModel(model: String) = settings.put(K_MODEL, model.trim().ifBlank { null })

    /**
     * 사용 가능한 Copilot 채팅 모델 목록(GitHub Copilot /models). 각 항목에 `premium`(프리미엄 요청 필요 — 계정에
     * 권한 없으면 429) 플래그를 실어 UI 가 "포함/프리미엄" 을 구분·정렬한다. 내부용(에이전트/검색/피커) 모델은 제외.
     * 실패 시 빈 목록.
     */
    fun availableModels(): List<Map<String, Any>> {
        val bearer = copilotBearer() ?: return emptyList()
        return try {
            val uri = URI.create("$COPILOT_CHAT_BASE/models")
            ssrfGuard.check(uri)
            var b = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(20))
                .header("Authorization", "Bearer $bearer").header("accept", "application/json")
            copilotHeaders().forEach { (k, v) -> b = b.header(k, v) }
            val res = http.send(b.GET().build(), HttpResponse.BodyHandlers.ofString())
            if (res.statusCode() >= 400) { log.warn("Copilot /models {} ", res.statusCode()); return emptyList() }
            val root = mapper.readTree(res.body())
            val arr = if (root.path("data").isArray) root.path("data") else root
            arr.mapNotNull { m ->
                val id = m.path("id").asText(null) ?: return@mapNotNull null
                if (isInternalModel(id)) return@mapNotNull null // 에이전트/검색/피커/컴팩션 등 사용자 선택 대상 아님
                val caps = m.path("capabilities")
                val chat = !m.has("capabilities") || caps.path("type").asText("chat") == "chat"
                if (!chat) return@mapNotNull null
                val ctx = caps.path("limits").path("max_context_window_tokens").asInt(0)
                mapOf<String, Any>(
                    "id" to id,
                    "name" to m.path("name").asText(id),
                    "premium" to isPremiumModel(id),
                    "recommended" to isRecommendedModel(id),
                    "vendor" to m.path("vendor").asText(""),
                    "contextTokens" to ctx,
                    "vision" to !caps.path("limits").path("vision").isMissingNode,
                    "preview" to m.path("preview").asBoolean(false),
                )
            }.distinctBy { it["id"] }
                // 포함(무료) 모델 먼저 → 이름순
                .sortedWith(compareBy({ it["premium"] as Boolean }, { (it["id"] as String) }))
        } catch (e: Exception) { log.warn("Copilot 모델 목록 실패: {}", e.message); emptyList() }
    }

    /** 내부/비대화용 모델(사용자 선택 대상 아님) — id 패턴으로 제외. */
    private fun isInternalModel(id: String): Boolean {
        val i = id.lowercase()
        return i.startsWith("auto-model") || i.startsWith("copilot-search") || i.startsWith("exec-agent") ||
            i.startsWith("trajectory") || i.startsWith("mai-code") || i.startsWith("oswe") ||
            i.endsWith("-picker") || i.endsWith("-secondary") || i.endsWith("-tertiary")
    }

    /**
     * 프리미엄 요청(유료 쿼터) 모델 추정 — Copilot 의 "포함(base)" 모델(0x)은 gpt-4o·gpt-4.1 계열·gpt-4o-mini 뿐이고
     * 나머지(claude-*, gemini-*, gpt-5.*, o1/o3, gpt-4-turbo 등)는 프리미엄. GitHub 정책 변화에 대비한 휴리스틱(정확한 청구는 GitHub 이 판단).
     */
    private fun isPremiumModel(id: String): Boolean {
        val i = id.lowercase()
        val base = i == "gpt-4o-mini" || i.startsWith("gpt-4o") || i.startsWith("gpt-4.1") || i == "gpt-3.5-turbo"
        return !base
    }

    /**
     * 기본 노출 대상(권장) 여부 — 날짜/버전 스냅샷 핀과 레거시 계열은 '더보기'로 숨긴다.
     * 예: gpt-4o-2024-11-20·gpt-4-0613·gpt-4.1-2025-04-14(스냅샷), gpt-3.5-*·gpt-4/gpt-4-*(레거시)는 숨김.
     */
    private fun isRecommendedModel(id: String): Boolean {
        val i = id.lowercase()
        if (Regex(".*-\\d{4}-\\d{2}-\\d{2}$").matches(i)) return false // 날짜 스냅샷(gpt-4o-2024-11-20)
        if (Regex(".*-\\d{4}$").matches(i)) return false               // 버전 핀(gpt-4-0613, gpt-3.5-turbo-0613)
        if (i.startsWith("gpt-3.5")) return false                      // 레거시 3.5
        if (i == "gpt-4" || i.startsWith("gpt-4-")) return false       // 구 GPT-4(gpt-4o/gpt-4.1 은 아님)
        return true
    }

    // --- 저장/HTTP ---

    private fun githubToken(): String? {
        val user = currentUser()
        // 사용자별 키 우선, 없으면 dev 는 레거시(분리 이전) 키 폴백 → 기존 연결 유지(재로그인 불필요).
        val raw = settings.get(tokenKey(user)) ?: (if (user == DEV_USER) settings.get(K_TOKEN) else null)
        return raw?.takeIf { it.isNotBlank() }?.let {
            try { crypto.decrypt(it) } catch (e: Exception) { log.warn("GitHub 토큰 복호화 실패: {}", e.message); null }
        }
    }
    private fun saveGithubToken(user: String, t: String) = settings.put(tokenKey(user), crypto.encrypt(t))

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
        // 기본 모델 — Copilot 요금제의 "포함(base)" 모델이라 프리미엄 쿼터 없이 동작(셋아웃 1위: 플로우 생성 정확도/속도).
        // 프리미엄(claude-sonnet-*, gpt-5.*)은 계정에 프리미엄 요청 권한이 있을 때만 선택 가능(없으면 429 quota exceeded).
        const val DEFAULT_MODEL = "gpt-4.1"
        const val K_MODEL = "assistant.copilot.model"
        const val DEV_USER = "dev" // dev(무인증) 모드의 단일 사용자명 — AuthController.me() 와 동일
        const val EDITOR_VERSION = "vscode/1.95.0"
        const val PLUGIN_VERSION = "copilot-chat/0.22.0"
        const val USER_AGENT = "GitHubCopilotChat/0.22.0"
        const val K_TOKEN = "assistant.oauth.token"
    }
}
