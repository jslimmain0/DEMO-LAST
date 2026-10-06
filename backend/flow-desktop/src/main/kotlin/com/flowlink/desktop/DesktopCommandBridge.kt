package com.flowlink.desktop

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import com.flowlink.common.bridge.*
import com.flowlink.common.lifecycle.RuntimeUpdateGate
import com.flowlink.execution.engine.StateCrypto
import jakarta.annotation.PreDestroy
import org.springframework.stereotype.Component
import org.springframework.context.annotation.Profile
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap

/** PC-initiated only. No inbound PC port or local credentials are published to the server. */
@Component
@Profile("desktop")
class DesktopCommandBridge(private val connection: DesktopConnection, private val session: DesktopSession,
    private val mapper: ObjectMapper, private val gate: RuntimeUpdateGate) {
    private val clock = Executors.newSingleThreadScheduledExecutor { Thread(it, "desktop-command-poll").apply { isDaemon = true } }
    private val workers = Executors.newFixedThreadPool(2) { Thread(it, "desktop-command-work").apply { isDaemon = true } }
    private val local = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build()
    private val active = ConcurrentHashMap.newKeySet<java.util.UUID>()
    private val outgoing = ConcurrentHashMap<java.util.UUID, DesktopCommandResult>()
    private val crypto = StateCrypto(session.encryptionKey)
    private val directory = session.directory.resolve("bridge-journal").also { Files.createDirectories(it); DesktopSession.protect(it) }
    @Volatile private var registered: DesktopBridgeSession? = null
    @Volatile private var identity: DesktopConnection.View? = null
    @Volatile private var identityToken: String? = null
    @EventListener(ApplicationReadyEvent::class) fun start() { clock.scheduleWithFixedDelay(::poll, 0, 1, TimeUnit.SECONDS) }
    @EventListener fun disconnected(event: DesktopServerDisconnected) { registered = null; identity = null; identityToken = null; outgoing.clear() }
    private fun headers(s: DesktopBridgeSession) = mapOf("X-FlowLink-PC-Session" to s.sessionId, "X-FlowLink-PC-Key" to s.credential)
    private fun same(view: DesktopConnection.View, token: String) = connection.view().let { it.connected && it.serverUrl == view.serverUrl && it.login == view.login } && runCatching { connection.token() == token }.getOrDefault(false)
    private fun poll() {
        val view = connection.view()
        if (!view.connected || view.login == null) { registered = null; return }
        try {
            val token = connection.token()
            if (registered == null || identity?.serverUrl != view.serverUrl || identity?.login != view.login || identityToken != token) {
                val response = connection.authenticatedJson("POST", "/api/v1/desktop-bridge/connect", mapper.valueToTree(DesktopBridgeRegistration(session.deviceId)), view.serverUrl, view.login)
                if (!same(view, token)) return
                outgoing.clear() // A new server session fences completions claimed by the old session.
                registered = mapper.treeToValue(response, DesktopBridgeSession::class.java); identity = view; identityToken = token
            }
            val channel = registered ?: return
            for ((id, result) in outgoing.entries.toList()) {
                connection.authenticatedJson("POST", "/api/v1/desktop-bridge/complete", mapper.valueToTree(result), view.serverUrl, view.login, headers(channel))
                outgoing.remove(id, result)
            }
            val commands = connection.authenticatedJson("POST", "/api/v1/desktop-bridge/poll", null, view.serverUrl, view.login, headers(channel))
            for (node in commands) {
                val command = mapper.treeToValue(node, DesktopCommand::class.java)
                if (active.add(command.requestId)) workers.execute {
                    try {
                        val result = gate.work { execute(command, view, token) }
                        if (same(view, token) && registered == channel) outgoing[command.requestId] = result
                    } catch (_: Exception) {
                        if (same(view, token) && registered == channel) outgoing[command.requestId] = DesktopCommandResult(command.requestId, "UNKNOWN", message = "처리 여부를 확인할 수 없습니다. 같은 요청을 자동으로 다시 실행하지 않습니다.")
                    } finally { active.remove(command.requestId) }
                }
            }
        } catch (e: DesktopRemoteException) { if (e.status in setOf(403, 409)) registered = null }
        catch (_: Exception) { /* Offline is not logout; keep the same command IDs and encrypted local journal. */ }
    }
    private fun execute(command: DesktopCommand, view: DesktopConnection.View, token: String): DesktopCommandResult {
        DesktopCommandPolicy.validate(command)
        check(same(view, token)) { "회사 연결이 변경되었습니다." }
        val file = directory.resolve("${command.requestId}.enc")
        val fingerprint = java.security.MessageDigest.getInstance("SHA-256").digest(mapper.writeValueAsBytes(command) + "${view.serverUrl}|${view.login}".toByteArray()).joinToString("") { "%02x".format(it) }
        if (Files.exists(file)) {
            val saved = mapper.readTree(crypto.decrypt(Files.readString(file)))
            check(saved.path("fingerprint").asText() == fingerprint)
            return mapper.treeToValue(saved.path("result"), DesktopCommandResult::class.java)
        }
        Files.list(directory).use { files -> check(files.filter { it.fileName.toString().endsWith(".enc") }.limit(10_001).count() < 10_000) { "개인 작업 기록 한도에 도달했습니다. PC에서 기록을 확인하세요." } }
        // Persist UNKNOWN before any mutation: a crash never turns an ambiguous request into an automatic retry.
        persist(file, fingerprint, DesktopCommandResult(command.requestId, "UNKNOWN", message = "이 작업의 완료 여부를 확인해야 합니다. 자동 재실행하지 않습니다."))
        var body = command.body
        if (command.method == "POST" && (command.path.endsWith("/run") || command.path.endsWith("/runs") || command.path.endsWith("/rerun"))) {
            body = (body?.deepCopy<com.fasterxml.jackson.databind.JsonNode>() as? ObjectNode ?: mapper.createObjectNode()).apply { put("clientExecutionId", command.requestId.toString()) }
        }
        val query = command.query.entries.joinToString("&") { "${URLEncoder.encode(it.key, Charsets.UTF_8)}=${URLEncoder.encode(it.value, Charsets.UTF_8)}" }
        val builder = HttpRequest.newBuilder(URI.create(session.baseUrl + command.path + if (query.isEmpty()) "" else "?$query"))
            .timeout(Duration.ofMinutes(5)).header("X-FlowLink-Local", session.token).header("Content-Type", "application/json")
        if (command.path.startsWith("/api/v1/remote/")) builder.header("X-FlowLink-Account", view.login!!).header("X-FlowLink-Server", view.serverUrl)
        val response = local.send(builder.method(command.method, body?.let { HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(it)) } ?: HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofInputStream())
        val bytes = response.body().use { it.readNBytes(DesktopCommandPolicy.MAX_BYTES + 1) }
        val result = if (bytes.size > DesktopCommandPolicy.MAX_BYTES) DesktopCommandResult(command.requestId, "UNKNOWN", message = "응답이 1MB를 초과했습니다. PC에서 결과를 확인하세요.")
            else DesktopCommandResult(command.requestId, if (response.statusCode() in 200..299) "SUCCEEDED" else "FAILED", response.statusCode(), if (bytes.isEmpty()) null else redact(runCatching { mapper.readTree(bytes) }.getOrElse { mapper.valueToTree(mapOf("message" to "PC에서 결과를 확인하세요.")) }))
        persist(file, fingerprint, result)
        return result
    }
    private fun redact(node: com.fasterxml.jackson.databind.JsonNode): com.fasterxml.jackson.databind.JsonNode {
        if (node is ObjectNode) {
            val fields = node.fieldNames().asSequence().toList()
            for (key in fields) if (key.lowercase() in setOf("token", "password", "secret", "secrets", "authorization", "credential", "claimtoken", "devicekey")) node.remove(key) else node.set<com.fasterxml.jackson.databind.JsonNode>(key, redact(node.get(key)))
        } else if (node.isArray) node.forEach { redact(it) }
        return node
    }
    private fun persist(file: java.nio.file.Path, fingerprint: String, result: DesktopCommandResult) {
        val temp = Files.createTempFile(directory, "command-", ".enc"); DesktopSession.protect(temp)
        val value = mapper.createObjectNode().put("fingerprint", fingerprint).set<ObjectNode>("result", mapper.valueToTree(result))
        Files.writeString(temp, crypto.encrypt(mapper.writeValueAsString(value)))
        Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }
    @PreDestroy fun stop() { clock.shutdownNow(); workers.shutdownNow() }
}
