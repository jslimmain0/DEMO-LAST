package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Assertions.assertTimeoutPreemptively
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.springframework.context.ApplicationEventPublisher
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class DesktopMetadataTest {
    @TempDir lateinit var directory: Path
    private val mapper = jacksonObjectMapper()
    private val events = ApplicationEventPublisher { }

    @Test fun `초기 주소의 안내 조회는 앱 시작을 막지 않고 로그인 없이 MCP 주소만 저장한다`() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val server = metadataServer {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            "https://tools.example/mcp"
        }
        try {
            val base = "http://127.0.0.1:${server.address.port}"
            Files.writeString(directory.resolve("server-url.txt"), base)
            DesktopSession(directory.toString(), 18182).use { session ->
                val connection = DesktopConnection(session, mapper, events)
                assertTimeoutPreemptively(Duration.ofSeconds(1)) { connection.refreshMetadataOnStartup() }
                assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue()
                assertThat(connection.view().serverUrl).isEqualTo(base)
                assertThat(connection.view().connected).isFalse()
                assertThat(connection.view().mcpUrl).isEmpty()
                release.countDown()
                await().atMost(Duration.ofSeconds(3)).untilAsserted {
                    assertThat(connection.view().mcpUrl).isEqualTo("https://tools.example/mcp")
                }
                assertThat(connection.view().connected).isFalse()
                assertThat(connection.view().login).isNull()
                // 새 패키지/초기값이 달라져도 사용자가 저장한 서버 설정이 우선한다.
                Files.writeString(directory.resolve("server-url.txt"), "https://another.example")
                assertThat(DesktopConnection(session, mapper, events).view()).isEqualTo(connection.view())
            }
        } finally { release.countDown(); server.stop(0) }
    }

    @ParameterizedTest
    @ValueSource(booleans = [false, true])
    fun `기동 안내의 늦은 응답은 같은 주소 또는 다른 주소 재설정을 덮지 않는다`(sameServer: Boolean) {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val requests = AtomicInteger()
        val workers = Executors.newCachedThreadPool()
        val first = metadataServer(workers) {
            if (requests.getAndIncrement() == 0) {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                "https://old.example/mcp"
            } else "https://current.example/mcp"
        }
        val second = metadataServer { "https://current.example/mcp" }
        try {
            Files.writeString(directory.resolve("server-url.txt"), "http://127.0.0.1:${first.address.port}")
            DesktopSession(directory.toString(), 18182).use { session ->
                val connection = DesktopConnection(session, mapper, events)
                val refresh = CompletableFuture.runAsync { connection.refreshMetadata() }
                assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue()
                val chosen = "http://127.0.0.1:${if (sameServer) first.address.port else second.address.port}"
                connection.configure(chosen)
                release.countDown()
                refresh.get(3, TimeUnit.SECONDS)
                assertThat(connection.view().serverUrl).isEqualTo(chosen)
                assertThat(connection.view().mcpUrl).isEqualTo("https://current.example/mcp")
                assertThat(DesktopConnection(session, mapper, events).view()).isEqualTo(connection.view())
            }
        } finally { release.countDown(); first.stop(0); second.stop(0); workers.shutdownNow() }
    }

    @Test fun `새 설치의 안내 조회 실패와 빈 주소는 로그인이나 개인 설정을 만들지 않는다`() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/v1/distribution") { exchange -> exchange.sendResponseHeaders(503, -1); exchange.close() }
        server.start()
        try {
            DesktopSession(directory.toString(), 18182).use { session ->
                val noServer = DesktopConnection(session, mapper, events)
                noServer.refreshMetadata()
                assertThat(noServer.view().serverUrl).isEmpty()
                Files.writeString(directory.resolve("server-url.txt"), "http://127.0.0.1:${server.address.port}")
                val offline = DesktopConnection(session, mapper, events)
                val initial = offline.view()
                offline.refreshMetadata()
                assertThat(offline.view()).isEqualTo(initial)
                assertThat(Files.exists(directory.resolve("server-session.enc"))).isFalse()
            }
        } finally { server.stop(0) }
    }

    @Test fun `공개 주소는 HTTPS이며 명시적인 루프백 HTTP만 개발용으로 허용한다`() {
        for (url in listOf("https://flowlink.example/app/", "http://127.0.0.1:18080", "http://localhost:18080", "http://[::1]:18080", "HTTP://LOCALHOST:18080")) {
            assertThat(DesktopConnection.validateUrl(url)).isEqualTo(url.trimEnd('/'))
        }
        for (url in listOf("", "//example.com", "http://internal.example", "https://user:pass@example.com", "https://example.com?secret=x", "https://example.com#fragment", "https://example.com:70000", "https://example.com:0")) {
            assertThatThrownBy { DesktopConnection.validateUrl(url) }.isInstanceOf(com.flowlink.common.error.BadRequestException::class.java)
        }
    }

    private fun metadataServer(executor: java.util.concurrent.Executor? = null, mcp: () -> String): HttpServer =
        HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            this.executor = executor
            createContext("/api/v1/distribution") { exchange ->
                assertThat(exchange.requestHeaders.getFirst("Authorization")).isNull()
                assertThat(exchange.requestHeaders.getFirst("X-FlowLink-Local")).isNull()
                val bytes = mapper.writeValueAsBytes(mapOf("mcpUrl" to mcp()))
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(200, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
            start()
        }
}
