package com.flowlink.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.core.env.Environment
import org.springframework.http.HttpStatus
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.oauth2.core.AuthorizationGrantType
import org.springframework.security.oauth2.core.ClientAuthenticationMethod
import org.springframework.security.oauth2.server.authorization.client.RegisteredClient
import org.springframework.security.oauth2.server.authorization.settings.ClientSettings
import org.springframework.security.web.context.HttpSessionSecurityContextRepository
import org.springframework.security.web.savedrequest.HttpSessionRequestCache
import org.springframework.web.server.ResponseStatusException
import org.springframework.web.util.HtmlUtils
import org.springframework.web.util.UriComponentsBuilder
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets.UTF_8
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class McpOAuthService(private val mapper: ObjectMapper, private val env: Environment, private val clients: McpClientRepository) {
    private data class Login(val session: String, val redirect: String, val expires: Instant, var device: JsonNode? = null)
    private val logins = ConcurrentHashMap<String, Login>()
    private val rates = linkedMapOf<String, Pair<Instant, Int>>()
    private val http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(10)).build()
    private val page = javaClass.getResourceAsStream("/mcp-login.html")!!.bufferedReader(UTF_8).use { it.readText() }

    @Synchronized fun register(body: JsonNode, request: HttpServletRequest): Map<String, Any> {
        val now = Instant.now()
        rates.entries.removeIf { it.value.first.plusSeconds(60).isBefore(now) }
        val count = rates[request.remoteAddr]?.second ?: 0
        if (count >= 10 || rates.size > 10_000) fail("클라이언트 등록 요청이 너무 많습니다.", HttpStatus.TOO_MANY_REQUESTS)
        rates[request.remoteAddr] = (rates[request.remoteAddr]?.first ?: now) to (count + 1)
        val values = body.path("redirect_uris")
        if (!values.isArray || values.size() !in 1..16) fail("redirect_uris가 필요합니다.")
        val redirects = values.map { if (!it.isTextual) fail("잘못된 redirect URI입니다."); it.asText().also(::validateRedirect) }
        if (body.has("grant_types") && body.path("grant_types").map { it.asText() } != listOf("authorization_code")) fail("authorization_code만 지원합니다.")
        if (body.has("response_types") && body.path("response_types").map { it.asText() } != listOf("code")) fail("code 응답만 지원합니다.")
        val method = body.path("token_endpoint_auth_method").asText("none")
        if (method !in setOf("none", "client_secret_post")) fail("지원하지 않는 클라이언트 인증 방식입니다.")
        val name = body.path("client_name").asText("MCP 클라이언트").take(200)
        val id = UUID.randomUUID().toString()
        val secret = if (method == "client_secret_post") UUID.randomUUID().toString() + UUID.randomUUID() else null
        val client = RegisteredClient.withId(id).clientId(id).clientName(name).clientIdIssuedAt(now)
            .clientAuthenticationMethod(ClientAuthenticationMethod(method)).authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
            .redirectUris { it.addAll(redirects) }.scope("flowlink")
            .clientSettings(ClientSettings.builder().requireProofKey(true).requireAuthorizationConsent(true).build())
        if (secret != null) client.clientSecret("{bcrypt}" + BCryptPasswordEncoder().encode(secret))
        clients.save(client.build())
        return linkedMapOf<String, Any>("client_id" to id, "client_id_issued_at" to now.epochSecond, "client_name" to name,
            "redirect_uris" to redirects, "token_endpoint_auth_method" to method, "grant_types" to listOf("authorization_code"), "response_types" to listOf("code"))
            .apply { if (secret != null) { put("client_secret", secret); put("client_secret_expires_at", 0) } }
    }

    @Synchronized fun loginPage(request: HttpServletRequest, response: HttpServletResponse): String {
        prune()
        if (logins.size >= 1000) fail("로그인 요청이 너무 많습니다.", HttpStatus.TOO_MANY_REQUESTS)
        val saved = HttpSessionRequestCache().getRequest(request, response) ?: fail("IDE에서 다시 인증을 시작하세요.")
        val uri = URI.create(saved.redirectUrl)
        if (uri.path != request.contextPath + "/authorize") fail("잘못된 인증 요청입니다.")
        val id = UriComponentsBuilder.fromUri(uri).build().queryParams.getFirst("client_id") ?: fail("클라이언트가 없습니다.")
        val client = clients.findByClientId(id) ?: fail("등록되지 않은 클라이언트입니다.")
        val tx = UUID.randomUUID().toString()
        logins[tx] = Login(request.getSession().id, saved.redirectUrl, Instant.now().plusSeconds(900))
        return page.replace("__TX__", tx).replace("__CLIENT__", HtmlUtils.htmlEscape(client.clientName))
    }

    fun start(tx: String, request: HttpServletRequest): JsonNode = synchronized(find(tx, request)) {
        val login = find(tx, request)
        login.device ?: api("POST", "/auth/github/device/start").also { login.device = it }
    }

    fun poll(tx: String, request: HttpServletRequest, response: HttpServletResponse): Map<String, Any?> = synchronized(find(tx, request)) {
        val login = find(tx, request)
        val session = login.device?.path("sessionId")?.asText()?.takeIf { it.isNotBlank() } ?: fail("먼저 로그인을 시작하세요.")
        val result = api("GET", "/auth/github/device/poll?session=" + URLEncoder.encode(session, UTF_8))
        if (result.path("status").asText() != "ready") return@synchronized mapOf("status" to result.path("status").asText("pending"), "error" to result.path("error").asText(null))
        val token = result.path("token").asText().takeIf { it.isNotBlank() } ?: fail("로그인 결과가 없습니다.")
        val context = SecurityContextHolder.createEmptyContext().apply {
            authentication = McpLoginAuthentication(result.path("login").asText(), token)
        }
        request.changeSessionId()
        HttpSessionSecurityContextRepository().saveContext(context, request, response)
        SecurityContextHolder.setContext(context)
        logins.remove(tx)
        mapOf("status" to "ready", "login" to result.path("login").asText(), "redirect" to login.redirect)
    }

    fun origin(request: HttpServletRequest): String = env.getProperty("FLOWLINK_PUBLIC_URL")?.trim()?.trimEnd('/')?.takeIf { it.isNotBlank() }
        ?: env.getProperty("flowlink.runtime.public-url")?.trim()?.trimEnd('/')?.takeIf { it.isNotBlank() }
        ?: "${request.scheme}://${request.serverName}${if (request.serverPort in setOf(80, 443)) "" else ":${request.serverPort}"}${request.contextPath}"

    fun metadata(request: HttpServletRequest): Map<String, Any> = origin(request).let { base -> mapOf("issuer" to base,
        "authorization_endpoint" to "$base/authorize", "token_endpoint" to "$base/token", "registration_endpoint" to "$base/register",
        "response_types_supported" to listOf("code"), "grant_types_supported" to listOf("authorization_code"),
        "code_challenge_methods_supported" to listOf("S256"), "token_endpoint_auth_methods_supported" to listOf("none", "client_secret_post")) }

    private fun find(tx: String, request: HttpServletRequest): Login {
        prune()
        val login = logins[tx] ?: fail("로그인 세션이 만료됐습니다.")
        if (request.getSession(false)?.id != login.session) fail("로그인 세션이 일치하지 않습니다.", HttpStatus.FORBIDDEN)
        val origin = request.getHeader("Origin")
        if (origin != null && origin != URI.create(this.origin(request)).let { "${it.scheme}://${it.rawAuthority}" }) fail("다른 출처의 로그인 요청입니다.", HttpStatus.FORBIDDEN)
        return login
    }
    private fun prune() { logins.entries.removeIf { it.value.expires.isBefore(Instant.now()) } }
    private fun api(method: String, path: String): JsonNode {
        val port = env.getProperty("local.server.port") ?: env.getProperty("server.port", "18080")
        val prefix = env.getProperty("server.servlet.context-path", "")
        val request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:$port$prefix/api/v1$path")).timeout(Duration.ofSeconds(30))
            .header("Content-Type", "application/json").method(method, if (method == "POST") HttpRequest.BodyPublishers.ofString("{}") else HttpRequest.BodyPublishers.noBody()).build()
        val result = http.send(request, HttpResponse.BodyHandlers.ofString())
        if (result.statusCode() !in 200..299) fail("서버 로그인을 진행하지 못했습니다.", HttpStatus.BAD_GATEWAY)
        return mapper.readTree(result.body())
    }

    companion object {
        fun validateRedirect(value: String) {
            if (value.length !in 1..2048) fail("잘못된 redirect URI입니다.")
            val uri = try { URI(value) } catch (_: Exception) { fail("잘못된 redirect URI입니다.") }
            if (!uri.isAbsolute || uri.rawFragment != null || uri.rawUserInfo != null) fail("잘못된 redirect URI입니다.")
            val allowed = (uri.scheme == "https" && !uri.host.isNullOrBlank()) ||
                (uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "[::1]")) ||
                uri.scheme in setOf("vscode", "vscode-insiders", "jetbrains")
            if (!allowed) fail("HTTPS 또는 PC의 인증 callback URI를 사용하세요.")
        }
        fun validatePublicUrl(value: String) {
            validateRedirect(value)
            val uri = URI(value)
            require(uri.scheme in setOf("http", "https") && uri.query == null) { "서버 공개 주소가 올바르지 않습니다." }
        }
        private fun fail(message: String, status: HttpStatus = HttpStatus.BAD_REQUEST): Nothing = throw ResponseStatusException(status, message)
    }
}
