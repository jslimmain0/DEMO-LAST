package com.flowlink.desktop

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.execution.engine.StateCrypto
import jakarta.annotation.PreDestroy
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.annotation.Profile
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.*
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption.*
import java.time.Duration
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** 로그인 한 번으로 사용자 IDE 설정을 유지한다. API 응답에는 주소·상태만 반환한다. */
@Service
@Profile("desktop")
class DesktopMcpSetup(private val session: DesktopSession, private val connection: DesktopConnection,
                      private val mapper: ObjectMapper,
                      @Value("\${flowlink.desktop.mcp-auto-configure:\${flowlink.desktop.tray:true}}") private val enabled: Boolean) {
    data class Grant(val tokenId: String, val accessToken: String, val expiresAt: String, val refreshAt: String = expiresAt)
    data class Ledger(val owner: DesktopConnection.State? = null, val grants: Map<String, Grant> = emptyMap(),
                      val managed: List<DesktopMcpSettings.Managed> = emptyList(),
                      val revoke: List<DesktopConnection.State> = emptyList())
    data class Client(val label: String, val configured: Boolean, val message: String)
    data class View(val phase: String, val message: String, val clients: List<Client> = emptyList(), val pendingRevocations: Int = 0)
    private val file = session.directory.resolve("mcp-setup.enc")
    private val crypto = StateCrypto(session.encryptionKey)
    private val settings = DesktopMcpSettings(mapper)
    private var ledger = if (Files.exists(file)) mapper.readValue(crypto.decrypt(Files.readString(file)), Ledger::class.java) else Ledger()
    private val worker = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "flowlink-ide-settings").apply { isDaemon = true } }
    @Volatile private var status = View("waiting", "회사 계정에 로그인하면 IDE 연결을 자동 설정합니다.")
    private val queued = java.util.concurrent.atomic.AtomicBoolean()
    private val revision = java.util.concurrent.atomic.AtomicLong()

    fun view() = status
    fun request(): View {
        revision.incrementAndGet()
        if (queued.compareAndSet(false, true)) worker.execute {
            var observed: Long
            do {
                observed = revision.get()
                try { reconcile(targets()) } finally { queued.set(false) }
            } while (revision.get() != observed && queued.compareAndSet(false, true))
        }
        return view()
    }
    private fun targets() = DesktopMcpSettings.discover(System.getenv("APPDATA")?.let(Path::of), System.getenv("LOCALAPPDATA")?.let(Path::of))
    @EventListener(ApplicationReadyEvent::class) fun ready() {
        worker.scheduleWithFixedDelay({ request() }, 0, 60, TimeUnit.SECONDS)
    }
    @EventListener(DesktopServerDisconnected::class) fun changed() { request() }
    @PreDestroy fun close() { worker.shutdownNow() }

    @Synchronized internal fun reconcile(targets: List<DesktopMcpSettings.Target>) {
        if (!enabled) { status = View("disabled", "이 실행에서는 IDE 자동 설정을 사용하지 않습니다."); return }
        try {
            val active = connection.snapshot()
            val owner = ledger.owner
            if (owner != null && (owner.serverUrl != active.serverUrl || owner.token != active.token || owner.login != active.login)) {
                // 암호화된 이전 세션으로 해제한다. 네트워크가 끊기면 재시도하며 만료를 넘기지 않는다.
                revokePending()
                if (owner !in ledger.revoke) {
                    check(ledger.revoke.size < 64) { "이전 계정 연결 해제가 대기 중입니다." }
                    save(ledger.copy(revoke = ledger.revoke + owner))
                }
                val remaining = ledger.managed.filter { record -> !runCatching { settings.remove(record) }.getOrDefault(false) }
                save(ledger.copy(managed = remaining))
                if (remaining.isNotEmpty()) {
                    status = View("error", "이전 로그인 항목을 직접 변경했거나 파일을 수정할 수 없습니다. 해당 항목을 정리한 뒤 다시 확인하세요.",
                        remaining.map { Client(it.path, false, "${it.key} 항목 확인 필요 · 다른 항목은 유지하세요.") }, ledger.revoke.size)
                    return
                }
                save(ledger.copy(owner = null, grants = emptyMap()))
            }
            revokePending()
            if (active.token == null || active.login == null) {
                status = View("waiting", "회사 계정에 로그인하면 IDE 연결을 자동 설정합니다.", pendingRevocations = ledger.revoke.size); return
            }
            val url = active.mcpUrl.takeIf { it.isNotBlank() } ?: active.serverUrl + "/mcp"
            val serverUri = URI.create(DesktopConnection.validateUrl(active.serverUrl))
            val mcpUri = URI.create(DesktopConnection.validateUrl(url))
            fun origin(uri: URI) = Triple(uri.scheme.lowercase(), uri.host.lowercase(), if (uri.port >= 0) uri.port else if (uri.scheme == "https") 443 else 80)
            check(origin(serverUri) == origin(mcpUri)) { "MCP 주소가 로그인 서버와 다릅니다. 관리자에게 연결 주소를 확인하세요." }
            if (targets.isEmpty()) {
                status = View("no-ide", "VS Code 또는 IntelliJ Copilot을 처음 실행한 뒤 다시 확인하세요.", pendingRevocations = ledger.revoke.size); return
            }
            save(ledger.copy(owner = active))
            val clients = targets.map { target ->
                try {
                    check(connection.snapshot() == active) { "로그인 계정이 변경되었습니다." }
                    var grant = ledger.grants[target.clientId]
                    if (grant == null || Instant.parse(grant.refreshAt).isBefore(Instant.now())) {
                        val path = "/api/v1/auth/mcp-tokens" + (grant?.let { "/${it.tokenId}/refresh" } ?: "")
                        val body = if (grant == null) mapper.createObjectNode().put("deviceId", session.deviceId).put("clientId", target.clientId) else null
                        val response = try {
                            connection.authenticatedJson("POST", path, body, active.serverUrl, active.login, timeout = Duration.ofSeconds(15))
                        } catch (failure: DesktopRemoteException) {
                            if (grant == null || failure.status != 404) throw failure
                            connection.authenticatedJson("POST", "/api/v1/auth/mcp-tokens",
                                mapper.createObjectNode().put("deviceId", session.deviceId).put("clientId", target.clientId),
                                active.serverUrl, active.login, timeout = Duration.ofSeconds(15))
                        }
                        grant = parseGrant(response)
                        // 서버가 회전한 새 자격은 설정 쓰기보다 먼저 암호화 저장해 재시도를 보장한다.
                        save(ledger.copy(grants = ledger.grants + (target.clientId to grant)))
                    }
                    check(connection.snapshot() == active) { "로그인 계정이 변경되었습니다." }
                    val previous = ledger.managed.firstOrNull { it.path == target.path.toString() }
                    val managed = settings.apply(target, settings.entry(target.clientId, url, grant.accessToken), previous, session.deviceId) { prepared ->
                        save(ledger.copy(managed = ledger.managed.filterNot { it.path == prepared.path } + prepared))
                    }
                    save(ledger.copy(managed = ledger.managed.filterNot { it.path == managed.path } + managed))
                    Client(target.label, true, "설정 완료 · IDE에서 도구 사용을 승인하세요.")
                } catch (failure: Exception) {
                    Client(target.label, false, if (failure is DesktopRemoteException) "서버 연결을 확인하고 다시 시도하세요. (HTTP ${failure.status})" else "설정을 적용하지 못했습니다. 기존 파일을 확인하고 다시 시도하세요.")
                }
            }
            status = View(if (clients.all { it.configured }) "ready" else "error",
                if (clients.all { it.configured }) "Windows 앱 로그인을 공유하며 토큰을 자동 갱신합니다." else "일부 IDE 설정을 적용하지 못했습니다. 기존 설정은 보존합니다.", clients, ledger.revoke.size)
        } catch (failure: Exception) {
            status = View("error", "IDE 연결 설정을 확인하지 못했습니다. 서버 주소와 기존 IDE 설정을 확인하세요.", pendingRevocations = ledger.revoke.size)
        }
    }
    private fun parseGrant(response: JsonNode): Grant {
        val expiresAt = response.path("expiresAt").asText()
        val now = Instant.now()
        val expiry = Instant.parse(expiresAt)
        val grant = Grant(response.path("tokenId").asText(), response.path("accessToken").asText(), expiresAt,
            now.plusSeconds((Duration.between(now, expiry).seconds * 4 / 5).coerceAtLeast(1)).toString())
        require(grant.tokenId.matches(Regex("[a-zA-Z0-9-]{1,64}")) && grant.accessToken.isNotBlank() && grant.accessToken.length <= 16_384)
        require(Instant.parse(grant.expiresAt).isAfter(Instant.now()))
        return grant
    }
    private fun revokePending() {
        val previous = ledger.revoke.firstOrNull() ?: return
        val request = HttpRequest.newBuilder(URI.create(previous.serverUrl + "/api/v1/auth/mcp-tokens"))
            .timeout(Duration.ofSeconds(15)).header("Authorization", "Bearer ${previous.token}").DELETE().build()
        val code = runCatching { connection.client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() }.getOrNull()
        if (code != null && (code in 200..299 || code == 401)) save(ledger.copy(revoke = ledger.revoke.drop(1)))
        else if (ledger.revoke.size > 1) save(ledger.copy(revoke = ledger.revoke.drop(1) + previous))
    }
    private fun save(value: Ledger) {
        val temp = Files.createTempFile(session.directory, "mcp-", ".enc")
        try {
            DesktopSession.protect(temp)
            Files.writeString(temp, crypto.encrypt(mapper.writeValueAsString(value)))
            Files.move(temp, file, ATOMIC_MOVE, REPLACE_EXISTING)
            ledger = value
        } finally { Files.deleteIfExists(temp) }
    }
}

@RestController
@Profile("desktop")
class DesktopMcpSetupController(private val setup: DesktopMcpSetup) {
    @GetMapping("/api/v1/desktop/mcp") fun view() = setup.view()
    @PostMapping("/api/v1/desktop/mcp/reconcile") fun reconcile() = setup.request()
}
