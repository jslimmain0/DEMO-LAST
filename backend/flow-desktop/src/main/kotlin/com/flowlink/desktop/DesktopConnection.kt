package com.flowlink.desktop

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.execution.engine.StateCrypto
import jakarta.servlet.http.HttpServletRequest
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.annotation.Profile
import org.springframework.context.event.EventListener
import org.springframework.http.ResponseEntity
import org.springframework.stereotype.Service
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.io.IOException
import org.springframework.http.HttpStatus
import org.springframework.web.server.ResponseStatusException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.time.Duration

/** 원격 로그인은 PC의 별도 암호화 파일에 보관한다. 개인 H2나 워크플로를 원격에 복제하지 않는다. */
@Service
@Profile("desktop")
class DesktopConnection(private val session: DesktopSession, private val mapper: ObjectMapper, private val events: org.springframework.context.ApplicationEventPublisher) : com.flowlink.common.host.LocalServerConnection {
    data class State(val serverUrl: String = "", val mcpUrl: String = "", val login: String? = null, val token: String? = null)
    data class View(val serverUrl: String, val mcpUrl: String, val login: String?, val connected: Boolean)
    private val file = session.directory.resolve("server-session.enc")
    private val crypto = StateCrypto(session.encryptionKey)
    val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build()
    @Volatile private var state: State = load()
    private var pending: Pair<String, String>? = null // 서버 주소 + 1회용 로그인 세션
    private val log = LoggerFactory.getLogger(DesktopConnection::class.java)

    /** 안내 정보 조회가 개인 앱 기동이나 저장된 서버 로그인 사용을 기다리게 하지 않는다. */
    @EventListener(ApplicationReadyEvent::class)
    fun refreshMetadataOnStartup() {
        if (state.serverUrl.isBlank()) return
        Thread({ refreshMetadata() }, "flowlink-desktop-metadata").apply { isDaemon = true }.start()
    }

    internal fun refreshMetadata() {
        val original = state
        if (original.serverUrl.isBlank()) return
        runCatching {
            val mcp = metadataMcpUrl(original.serverUrl)
            synchronized(this) {
                // 로그인/로그아웃/주소 변경 또는 더 최근 configure 뒤 도착한 응답은 버린다.
                if (state === original && original.mcpUrl != mcp) save(original.copy(mcpUrl = mcp))
            }
        }.onFailure {
            // 인증·연결 성공을 주장하지 않는다. 캐시된 주소와 개인 작업은 그대로 사용할 수 있다.
            log.info("서버 연결 안내를 갱신하지 못했습니다. 개인 작업과 기존 로그인 설정은 유지됩니다.")
        }
    }

    private fun load(): State {
        if (Files.exists(file)) return mapper.readValue(crypto.decrypt(Files.readString(file)), State::class.java)
        val bundle = System.getProperty("flowlink.bundle.dir")?.let { Path.of(it, "server.json") }
        val url = if (bundle != null && Files.exists(bundle)) mapper.readTree(Files.readString(bundle)).path("serverUrl").asText("")
            else session.directory.resolve("server-url.txt").takeIf { Files.exists(it) }?.let { Files.readString(it).trim() }.orEmpty()
        return State(serverUrl = if (url.isBlank()) "" else validateUrl(url))
    }

    fun view() = state.let { View(it.serverUrl, it.mcpUrl, it.login, it.token != null) }
    internal fun snapshot() = state
    override fun connectionIdentity() = state.let { com.flowlink.common.host.LocalServerIdentity(it.serverUrl, it.login, it.token != null) }
    fun token(): String = state.token ?: throw BadRequestException("Windows 앱에서 서버에 로그인하세요.")
    fun serverUrl(): String = state.serverUrl.takeIf { it.isNotBlank() } ?: throw BadRequestException("서버 주소를 먼저 설정하세요.")

    /** 승인한 서버·계정과 일치하는 세션으로만 Dispatcher 작업을 요청한다. */
    fun authenticatedJson(method: String, path: String, body: com.fasterxml.jackson.databind.JsonNode? = null,
        expectedServer: String, expectedLogin: String?, extraHeaders: Map<String, String> = emptyMap(),
        timeout: Duration = Duration.ofMinutes(5)): com.fasterxml.jackson.databind.JsonNode {
        require(path.startsWith("/api/v1/") && !path.contains("..") && !path.contains('\\')) { "잘못된 에이전트 API 경로" }
        val active = state
        if (active.serverUrl != expectedServer || active.login != expectedLogin || active.token == null)
            throw BadRequestException("실행을 시작한 서버 계정으로 다시 로그인하세요.")
        val builder = HttpRequest.newBuilder(URI.create(active.serverUrl + path)).timeout(timeout)
            .header("Authorization", "Bearer ${active.token}").header("Content-Type", "application/json")
            .header("X-FlowLink-Device", session.deviceId)
        extraHeaders.forEach { (key, value) -> require(key in setOf("X-FlowLink-PC-Session", "X-FlowLink-PC-Key")); builder.header(key, value) }
        val request = builder.method(method, body?.let { HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(it)) }
                ?: HttpRequest.BodyPublishers.noBody()).build()
        val response = send(request, HttpResponse.BodyHandlers.ofInputStream())
        if (response.statusCode() == 401 && state.token == active.token) logout()
        val bytes = response.body().use { it.readNBytes(64 * 1024 * 1024 + 1) }
        if (bytes.size > 64 * 1024 * 1024) throw BadRequestException("에이전트 응답 크기가 64MB를 초과했습니다.")
        if (response.statusCode() !in 200..299) throw DesktopRemoteException(response.statusCode())
        return if (bytes.isEmpty()) mapper.nullNode() else mapper.readTree(bytes)
    }

    @Synchronized private fun save(value: State) {
        val temp = Files.createTempFile(session.directory, "server-", ".enc")
        DesktopSession.protect(temp)
        Files.writeString(temp, crypto.encrypt(mapper.writeValueAsString(value)))
        Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        val previous = state
        state = value
        if (previous.serverUrl != value.serverUrl || previous.token != value.token) events.publishEvent(DesktopServerDisconnected())
    }

    @Synchronized fun configure(url: String): View {
        val normalized = validateUrl(url)
        val mcp = metadataMcpUrl(normalized)
        if (normalized != state.serverUrl) { pending = null; save(State(normalized, mcp)) }
        else save(state.copy(mcpUrl = mcp))
        return view()
    }

    private fun metadataMcpUrl(base: String): String {
        val metadata = json(base, "GET", "/api/v1/distribution")
        val mcp = metadata.path("mcpUrl")
        if (!mcp.isMissingNode && !mcp.isNull && !mcp.isTextual) throw BadRequestException("서버 MCP 안내 주소가 올바르지 않습니다.")
        return mcp.asText("").takeIf { it.isNotBlank() }?.let(::validateUrl).orEmpty()
    }

    @Synchronized fun start(): Map<String, Any> {
        configure(serverUrl())
        val result = json(serverUrl(), "POST", "/api/v1/auth/github/device/start", "{}")
        pending = serverUrl() to result.path("sessionId").asText()
        return mapper.convertValue(result, object : com.fasterxml.jackson.core.type.TypeReference<Map<String, Any>>() {})
    }

    @Synchronized fun poll(): Map<String, Any?> {
        val (url, id) = pending ?: throw BadRequestException("로그인을 먼저 시작하세요.")
        val result = json(url, "GET", "/api/v1/auth/github/device/poll?session=$id")
        val status = result.path("status").asText()
        if (status == "ready") {
            val jwt = result.path("token").asText()
            if (jwt.isBlank()) throw BadRequestException("서버가 로그인 토큰을 반환하지 않았습니다.")
            val login = result.path("login").asText()
            save(state.copy(token = jwt, login = login)); pending = null
        } else if (status == "error") pending = null
        // JWT를 브라우저·MCP 설정·로그에 반환하지 않는다.
        return mapOf("status" to status, "login" to state.login, "error" to result.path("error").textValue())
    }

    @Synchronized fun logout() { pending = null; save(state.copy(token = null, login = null)) }

    private fun json(base: String, method: String, path: String, body: String? = null): com.fasterxml.jackson.databind.JsonNode {
        val request = HttpRequest.newBuilder(URI.create(base + path)).timeout(Duration.ofSeconds(25))
            .header("Content-Type", "application/json").method(method, body?.let { HttpRequest.BodyPublishers.ofString(it) } ?: HttpRequest.BodyPublishers.noBody()).build()
        val res = send(request, HttpResponse.BodyHandlers.ofString())
        if (res.statusCode() !in 200..299) throw BadRequestException("서버 연결 실패 (HTTP ${res.statusCode()})")
        return mapper.readTree(res.body())
    }

    fun forward(req: HttpServletRequest): ResponseEntity<ByteArray> {
        val suffix = req.requestURI.removePrefix("/api/v1/remote")
        val decoded = java.net.URLDecoder.decode(suffix, Charsets.UTF_8)
        if (!suffix.startsWith('/') || decoded.contains("..") || decoded.contains('\\') || decoded.contains("//")) throw BadRequestException("허용되지 않은 원격 경로입니다.")
        val path = "/api/v1$suffix" + (req.queryString?.let { "?$it" } ?: "")
        var bytes = req.inputStream.readNBytes(21 * 1024 * 1024 + 1)
        if (bytes.size > 21 * 1024 * 1024) throw BadRequestException("요청 크기가 21MB를 초과했습니다.")
        val active = state
        val jwt = active.token ?: throw BadRequestException("Windows 앱에서 서버에 로그인하세요.")
        val expectedAccount = req.getHeader("X-FlowLink-Account")
        val expectedServer = req.getHeader("X-FlowLink-Server")
        if ((expectedAccount != null && expectedAccount != active.login) || (expectedServer != null && expectedServer != active.serverUrl))
            return ResponseEntity.status(409).header("Content-Type", "application/json").header("Cache-Control", "no-store")
                .body(mapper.writeValueAsBytes(mapOf("message" to "서버 또는 계정이 변경되었습니다. 화면을 다시 열고 시도하세요.")))
        val startsRun = req.method == "POST" && (Regex("^/flows/[0-9a-fA-F-]{36}/runs$").matches(suffix) ||
            Regex("^/executions/[0-9a-fA-F-]{36}/rerun$").matches(suffix))
        val startsSuite = req.method == "POST" && suffix == "/suites/run"
        val trackedRuns = linkedMapOf<java.util.UUID, java.util.UUID>()
        if (startsRun || startsSuite) {
            val run = (if (bytes.isEmpty()) mapper.createObjectNode() else mapper.readTree(bytes)) as? com.fasterxml.jackson.databind.node.ObjectNode
                ?: throw BadRequestException("실행 요청은 JSON 객체여야 합니다.")
            fun uuid(value: String) = runCatching { java.util.UUID.fromString(value) }
                .getOrElse { throw BadRequestException("실행 또는 워크플로 ID가 올바르지 않습니다.") }
            if (startsSuite) {
                if (!run.path("flowIds").isArray) {
                    if (!run.hasNonNull("folderId")) throw BadRequestException("flowIds 또는 folderId가 필요합니다.")
                    val plan = authenticatedJson("POST", "/api/v1/suites/plan", run, active.serverUrl, active.login)
                    run.set<com.fasterxml.jackson.databind.JsonNode>("flowIds", mapper.createArrayNode().also { array -> plan.forEach { array.add(it.path("id").asText()) } })
                }
                val supplied = run.path("clientRunIds")
                val ids = mapper.createObjectNode()
                run.path("flowIds").map { uuid(it.asText()) }.distinct().forEach { flowId ->
                    val executionId = supplied.path(flowId.toString()).takeUnless { it.isMissingNode || it.isNull }
                        ?.let { uuid(it.asText()) } ?: java.util.UUID.randomUUID()
                    trackedRuns[flowId] = executionId; ids.put(flowId.toString(), executionId.toString())
                }
                if (trackedRuns.values.toSet().size != trackedRuns.size) throw BadRequestException("각 워크플로에는 서로 다른 실행 ID가 필요합니다.")
                run.set<com.fasterxml.jackson.databind.JsonNode>("clientRunIds", ids)
                run.remove("folderId") // 조회한 목록으로 고정: 승인 후 폴더에 추가된 흐름을 실행하지 않는다.
            } else {
                val id = if (run.hasNonNull("clientExecutionId")) uuid(run.path("clientExecutionId").asText()) else java.util.UUID.randomUUID()
                run.put("clientExecutionId", id.toString()); trackedRuns[id] = id
            }
            run.put("agentDeviceId", session.deviceId)
            bytes = mapper.writeValueAsBytes(run)
            // 응답이 유실되어도 같은 ID를 조회한다. 시작 API의 clientExecutionId 멱등성을 사용한다.
            trackedRuns.values.forEach { events.publishEvent(DesktopRemoteRunStarted(it, active.serverUrl, active.login)) }
        }
        val request = HttpRequest.newBuilder(URI.create(active.serverUrl + path)).timeout(Duration.ofMinutes(5))
            .header("Authorization", "Bearer $jwt").header("Content-Type", req.contentType ?: "application/json")
            .header("X-FlowLink-Device", session.deviceId)
            .header("Accept", req.getHeader("Accept") ?: "application/json")
            .method(req.method, if (bytes.isEmpty()) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofByteArray(bytes)).build()
        val res = send(request, HttpResponse.BodyHandlers.ofInputStream())
        if (res.statusCode() == 401 && state.token == jwt) logout()
        val body = res.body().use { it.readNBytes(64 * 1024 * 1024 + 1) }
        if (body.size > 64 * 1024 * 1024) throw BadRequestException("원격 응답 크기가 64MB를 초과했습니다.")
        if (res.statusCode() in 400..499) trackedRuns.values.forEach { events.publishEvent(DesktopRemoteRunRejected(it)) }
        if (startsSuite && res.statusCode() in 200..299) {
            val accepted = mapper.readTree(body).mapNotNull { it.path("executionId").textValue() }.toSet()
            trackedRuns.values.filter { it.toString() !in accepted }.forEach { events.publishEvent(DesktopRemoteRunRejected(it)) }
        }
        val response = ResponseEntity.status(res.statusCode()).header("Cache-Control", "no-store")
        listOf("Content-Type", "Content-Disposition", "ETag").forEach { name -> res.headers().firstValue(name).ifPresent { response.header(name, it) } }
        return response.body(body)
    }

    private fun <T> send(request: HttpRequest, handler: HttpResponse.BodyHandler<T>): HttpResponse<T> =
        try { client.send(request, handler) }
        catch (_: IOException) { throw serverUnavailable() }
        catch (_: InterruptedException) { Thread.currentThread().interrupt(); throw serverUnavailable() }

    private fun serverUnavailable() = ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
        "회사 서버에 연결할 수 없습니다. 개인 워크스페이스는 계속 사용할 수 있습니다. 전송한 서버 작업은 결과를 확인한 뒤 다시 실행하세요.")

    companion object {
        fun validateUrl(value: String): String {
            val uri = runCatching { URI.create(value.trim().trimEnd('/')) }.getOrElse { throw BadRequestException("서버 주소가 올바르지 않습니다.") }
            val scheme = uri.scheme?.lowercase()
            val host = uri.host?.lowercase()
            if (host.isNullOrBlank() || uri.userInfo != null || uri.query != null || uri.fragment != null ||
                (uri.port != -1 && uri.port !in 1..65535) ||
                (scheme != "https" && !(scheme == "http" && host in listOf("127.0.0.1", "localhost", "[::1]"))))
                throw BadRequestException("사내 서버는 HTTPS 주소를 사용하세요. 로컬 테스트만 HTTP를 허용합니다.")
            return uri.toString()
        }
    }
}

class DesktopRemoteException(val status: Int) : RuntimeException("에이전트 서버 응답: HTTP $status")
data class DesktopRemoteRunStarted(val executionId: java.util.UUID, val serverUrl: String, val login: String?)
data class DesktopRemoteRunRejected(val executionId: java.util.UUID)
class DesktopServerDisconnected
