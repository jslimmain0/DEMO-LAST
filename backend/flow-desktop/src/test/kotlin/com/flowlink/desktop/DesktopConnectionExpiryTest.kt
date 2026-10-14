package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource
import org.springframework.context.ApplicationEventPublisher
import org.springframework.mock.web.MockHttpServletRequest
import java.net.InetSocketAddress
import java.lang.management.ManagementFactory
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** 지연된 401과 새 로그인만 합성한다. 실제 사용자 서버·설정은 사용하지 않는다. */
class DesktopConnectionExpiryTest {
    @TempDir lateinit var directory: Path

    @ParameterizedTest
    @CsvSource("false,false", "true,false", "false,true", "true,true")
    fun `이전 요청의 401은 다시 로그인한 세션을 지우지 않는다`(agentCall: Boolean, changeServer: Boolean) {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val workers = Executors.newCachedThreadPool()
        val mapper = jacksonObjectMapper()
        val logins = AtomicInteger()
        val requestThread = AtomicReference<Thread>()
        fun server(delayFirstRequest: Boolean): HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            executor = workers
            val first = AtomicBoolean(delayFirstRequest)
            createContext("/api/v1/") { exchange ->
                val (status, body) = when (exchange.requestURI.path) {
                    "/api/v1/distribution" -> 200 to "{}"
                    "/api/v1/auth/github/device/start" -> 200 to """{"sessionId":"synthetic"}"""
                    "/api/v1/auth/github/device/poll" -> 200 to """{"status":"ready","token":"synthetic-jwt-${logins.incrementAndGet()}","login":"fixture"}"""
                    else -> if (first.compareAndSet(true, false)) {
                        entered.countDown()
                        check(release.await(5, TimeUnit.SECONDS))
                        401 to "{}"
                    } else 200 to "{}"
                }
                val bytes = body.toByteArray()
                exchange.sendResponseHeaders(status, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
            start()
        }
        val first = server(true)
        val second = server(false)
        try {
            DesktopSession(directory.toString(), 18182).use { session ->
                val connection = DesktopConnection(session, mapper, ApplicationEventPublisher { })
                val oldBase = "http://127.0.0.1:${first.address.port}"
                connection.configure(oldBase); connection.start(); connection.poll()
                val oldRequest = CompletableFuture.supplyAsync {
                    requestThread.set(Thread.currentThread())
                    if (agentCall) {
                        try {
                            connection.authenticatedJson("GET", "/api/v1/workspaces", expectedServer = oldBase, expectedLogin = "fixture")
                            200
                        } catch (error: DesktopRemoteException) { error.status }
                    } else connection.forward(MockHttpServletRequest("GET", "/api/v1/remote/workspaces")).statusCode.value()
                }
                assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue()
                val newBase = if (changeServer) "http://127.0.0.1:${second.address.port}" else oldBase
                val (signedIn, encrypted) = synchronized(connection) {
                    release.countDown()
                    // 401 응답이 현재 연결의 monitor를 기다릴 때 로그인한다. 타이밍 sleep은 사용하지 않는다.
                    await().atMost(Duration.ofSeconds(3)).until {
                        val thread = requestThread.get()
                        thread.state == Thread.State.BLOCKED && ManagementFactory.getThreadMXBean()
                            .getThreadInfo(thread.threadId())?.lockInfo?.identityHashCode == System.identityHashCode(connection)
                    }
                    connection.configure(newBase); connection.start(); connection.poll()
                    assertThat(connection.token()).isEqualTo("synthetic-jwt-2")
                    connection.view() to Files.readAllBytes(session.directory.resolve("server-session.enc"))
                }
                assertThat(signedIn.connected).isTrue()
                assertThat(oldRequest.get(3, TimeUnit.SECONDS)).isEqualTo(401)
                assertThat(connection.view()).isEqualTo(signedIn)
                assertThat(Files.readAllBytes(session.directory.resolve("server-session.enc"))).isEqualTo(encrypted)
                assertThat(connection.forward(MockHttpServletRequest("GET", "/api/v1/remote/workspaces")).statusCode.value()).isEqualTo(200)
                assertThat(DesktopConnection(session, mapper, ApplicationEventPublisher { }).view()).isEqualTo(signedIn)
            }
        } finally { release.countDown(); first.stop(0); second.stop(0); workers.shutdownNow() }
    }
}
