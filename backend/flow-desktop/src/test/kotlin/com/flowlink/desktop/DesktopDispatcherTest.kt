package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.agent.*
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.ExecutionService
import com.flowlink.execution.engine.NodeResult
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.mockito.Mockito
import org.springframework.context.ApplicationEventPublisher
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

class DesktopDispatcherTest {
    @TempDir lateinit var directory: Path

    @Test fun `브라우저 없이 실행하고 결과 ACK 유실에는 결과만 재전달한다`() {
        val mapper = jacksonObjectMapper()
        val id = UUID.randomUUID()
        val taskId = UUID.randomUUID()
        val results = AtomicInteger()
        val node = mapper.readValue("""{"id":"pc","type":"http","executionAgent":"local"}""", GraphNode::class.java)
        val request = AgentNodeRequest(taskId, id, node)
        DesktopSession(directory.toString(), 18180).use { session ->
            val task = AgentTaskView(taskId, id, "pc", "local", "PENDING", session.deviceId)
            val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
            server.createContext("/api/v1/") { exchange ->
                val path = exchange.requestURI.path
                var status = 200
                val response: Any = when (path) {
                    "/api/v1/distribution" -> mapOf("mcpUrl" to "")
                    "/api/v1/auth/github/device/start" -> mapOf("sessionId" to "login")
                    "/api/v1/auth/github/device/poll" -> mapOf("status" to "ready", "token" to "private-jwt", "login" to "tester")
                    "/api/v1/executions/$id" -> mapOf("status" to if (results.get() >= 2) "SUCCEEDED" else "WAITING",
                        "pendingAgent" to PendingAgent(taskId, "pc", "PC 노드", "local"))
                    "/api/v1/agent/tasks/$taskId" -> task
                    "/api/v1/agent/tasks/$taskId/claim" -> task.copy(status = "CLAIMED", request = request, claimToken = "private-claim")
                    "/api/v1/agent/tasks/$taskId/result" -> {
                        val submitted = mapper.readTree(exchange.requestBody)
                        assertThat(submitted.path("deviceId").asText()).isEqualTo(session.deviceId)
                        assertThat(submitted.path("result").path("value").path("amount").isInt).isTrue()
                        if (results.incrementAndGet() == 1) status = 503
                        task.copy(status = "ACKED")
                    }
                    else -> error("예상하지 않은 Dispatcher 요청: $path")
                }
                val body = mapper.writeValueAsBytes(response)
                exchange.sendResponseHeaders(status, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            server.start()
            val connection = DesktopConnection(session, mapper, ApplicationEventPublisher { _ -> })
            val journal = DesktopDispatchJournal(session, mapper)
            val executor = Mockito.mock(AgentNodeExecutor::class.java)
            Mockito.`when`(executor.execute(request)).thenAnswer {
                assertThat(Thread.currentThread().isVirtual).isTrue()
                AgentNodeResult(NodeResult.ok(200, null, null, mapOf("amount" to 42)), 5)
            }
            val dispatcher = DesktopDispatcher(session, connection, journal, Mockito.mock(ExecutionService::class.java),
                Mockito.mock(AgentTaskService::class.java), executor, mapper)
            try {
                val base = "http://127.0.0.1:${server.address.port}"
                connection.configure(base); connection.start(); connection.poll()
                dispatcher.remoteStarted(DesktopRemoteRunStarted(id, base, "tester"))
                dispatcher.start()
                val end = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(8)
                while (journal.all().isNotEmpty() && System.nanoTime() < end) Thread.sleep(25)
                assertThat(journal.all()).isEmpty()
                assertThat(results.get()).isEqualTo(2)
                Mockito.verify(executor, Mockito.times(1)).execute(request)
                assertThat(Files.exists(directory.resolve("db"))).isFalse()
                assertThat(Files.readString(directory.resolve("dispatch-journal.enc"))).doesNotContain("private-claim", "private-jwt")
            } finally { dispatcher.close(); server.stop(0) }
        }
    }
}
