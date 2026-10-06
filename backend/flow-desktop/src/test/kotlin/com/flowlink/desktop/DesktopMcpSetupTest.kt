package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.execution.engine.StateCrypto
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.context.ApplicationEventPublisher
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/** 임시 설정 JSON과 모의 REST 인증만 검증한다. MCP 프로토콜·실제 IDE에는 접근하지 않는다. */
class DesktopMcpSetupTest {
    @TempDir lateinit var directory: Path
    @Test fun `로그인 설정 재시작 갱신과 오프라인 로그아웃 해제를 이어간다`() {
        val mapper = jacksonObjectMapper()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        var issued = 0
        var refreshed = 0
        var offline = false
        var revoked = 0
        val base = "http://127.0.0.1:${server.address.port}"
        server.createContext("/api/v1/") { exchange ->
            val path = exchange.requestURI.path
            val response = when {
                path == "/api/v1/distribution" -> 200 to """{"mcpUrl":"$base/mcp"}"""
                path.endsWith("device/start") -> 200 to """{"sessionId":"test-session"}"""
                path.endsWith("device/poll") -> 200 to """{"status":"ready","token":"test-app-secret","login":"tester"}"""
                else -> {
                    assertThat(exchange.requestHeaders.getFirst("Authorization")).isEqualTo("Bearer test-app-secret")
                    when (exchange.requestMethod) {
                        "DELETE" -> { if (offline) 503 to "{}" else { revoked++; 204 to "" } }
                        else -> {
                            val client = if (path.endsWith("refresh")) { refreshed++; "vscode" }
                                else { issued++; mapper.readTree(exchange.requestBody).path("clientId").asText() }
                            200 to """{"tokenId":"token-$client","accessToken":"test-mcp-$client-$refreshed","expiresAt":"${Instant.now().plusSeconds(604800)}","clientId":"$client","deviceId":"test"}"""
                        }
                    }
                }
            }
            val bytes = response.second.toByteArray()
            exchange.sendResponseHeaders(response.first, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            exchange.responseBody.use { if (bytes.isNotEmpty()) it.write(bytes) }
        }
        server.createContext("/offline/api/v1/auth/mcp-tokens") { exchange ->
            exchange.sendResponseHeaders(503, -1); exchange.close()
        }
        server.start()
        try {
            DesktopSession(directory.resolve("data").toString(), 18182).use { session ->
                val connection = DesktopConnection(session, mapper, ApplicationEventPublisher { })
                connection.configure(base); connection.start(); connection.poll()
                val paths = listOf("vscode", "intellij").map { id ->
                    val path = directory.resolve("$id.json")
                    Files.writeString(path, """{"servers":{"other":{"url":"https://other.example"}}}""")
                    DesktopMcpSettings.Target(id, id, path)
                }
                val setup = DesktopMcpSetup(session, connection, mapper, true)
                setup.reconcile(paths)
                assertThat(setup.view().phase).isEqualTo("ready")
                assertThat(issued).isEqualTo(2)
                assertThat(setup.view().toString()).doesNotContain("test-app-secret", "test-mcp-")
                val ledgerFile = session.directory.resolve("mcp-setup.enc")
                assertThat(Files.readString(ledgerFile)).doesNotContain("test-app-secret", "test-mcp-")
                val crypto = StateCrypto(session.encryptionKey)
                val ledger = mapper.readValue(crypto.decrypt(Files.readString(ledgerFile)), DesktopMcpSetup.Ledger::class.java)
                val changed = ledger.copy(grants = ledger.grants + ("vscode" to ledger.grants.getValue("vscode").copy(refreshAt = Instant.EPOCH.toString())))
                Files.writeString(ledgerFile, crypto.encrypt(mapper.writeValueAsString(changed)))
                setup.close()
                val restored = DesktopMcpSetup(session, connection, mapper, true)
                try {
                    restored.reconcile(paths)
                    assertThat(refreshed).isEqualTo(1)
                    assertThat(issued).isEqualTo(2)
                    assertThat(Files.readString(paths.first().path)).contains("test-mcp-vscode-1")
                    offline = true
                    connection.logout(); restored.reconcile(paths)
                    assertThat(restored.view().pendingRevocations).isEqualTo(1)
                    paths.forEach { assertThat(mapper.readTree(Files.readString(it.path)).path("servers").size()).isEqualTo(1) }
                    offline = false
                    restored.reconcile(paths)
                    assertThat(revoked).isEqualTo(1)
                    assertThat(restored.view().pendingRevocations).isZero()
                } finally { restored.close() }
                // 큐가 상한에 도달해도 온라인이면 먼저 해제해 계정 정리가 계속된다.
                val previous = ledger.owner!!
                val full = DesktopMcpSetup.Ledger(owner = previous, revoke = (0 until 64).map { previous.copy(login = "queued-$it") })
                Files.writeString(ledgerFile, crypto.encrypt(mapper.writeValueAsString(full)))
                val queued = DesktopMcpSetup(session, connection, mapper, true)
                try {
                    queued.reconcile(emptyList())
                    assertThat(queued.view().phase).isEqualTo("waiting")
                    assertThat(queued.view().pendingRevocations).isLessThan(64)
                } finally { queued.close() }
                val mixed = DesktopMcpSetup.Ledger(revoke = listOf(previous.copy(serverUrl = "$base/offline"), previous))
                Files.writeString(ledgerFile, crypto.encrypt(mapper.writeValueAsString(mixed)))
                val retry = DesktopMcpSetup(session, connection, mapper, true)
                try {
                    retry.reconcile(emptyList())
                    assertThat(retry.view().pendingRevocations).isEqualTo(2)
                    retry.reconcile(emptyList())
                    assertThat(retry.view().pendingRevocations).isEqualTo(1)
                } finally { retry.close() }
            }
        } finally { server.stop(0) }
    }
}
