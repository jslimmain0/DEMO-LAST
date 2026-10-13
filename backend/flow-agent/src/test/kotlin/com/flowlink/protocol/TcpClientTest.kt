package com.flowlink.protocol

import com.flowlink.mock.MockRuntimeStore
import com.flowlink.mock.MockSpec
import com.flowlink.mock.TcpMockSession
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.io.IOException
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class TcpClientTest {
    private val spec = ProtocolSpec(encoding = "UTF-8", lengthField = "length", includesSelf = true,
        header = listOf(ProtocolSpec.Field("length", 4, "length")),
        messages = listOf(ProtocolSpec.Message("request", fields = listOf(ProtocolSpec.Field("value", 4, "ascii"))),
            ProtocolSpec.Message("response", fields = listOf(ProtocolSpec.Field("value", 4, "ascii")))))
    private val request = "0008PING".toByteArray()

    @Test fun `연결 직후 실행이 취소되면 요청 바이트를 보내지 않고 소켓을 닫는다`() {
        ServerSocket(0).use { server ->
            server.soTimeout = 3000
            val received = CompletableFuture<Int>()
            val worker = thread(isDaemon = true) {
                try {
                    server.accept().use { socket ->
                        socket.soTimeout = 3000
                        received.complete(socket.getInputStream().read())
                    }
                } catch (e: Throwable) { received.completeExceptionally(e) }
            }
            try {
                TcpClient.Session("127.0.0.1", server.localPort, 2000).use { session ->
                    assertThatThrownBy { session.exchange(request, spec, beforeSend = { false }) }
                        .isInstanceOf(TcpSessionRegistry.NotSentException::class.java).hasMessageContaining("요청을 보내지 않았습니다")
                    assertThat(session.isClosed).isTrue()
                }
                assertThat(received.get(4, TimeUnit.SECONDS)).isEqualTo(-1)
            } finally { server.close(); worker.join(1000) }
        }
    }

    @Test fun `유지 연결은 두 요청을 한 소켓에서 4-way 왕복하고 ACK가 응답에 섞이지 않는다`() {
        val protocol = spec.copy(transport = ProtocolSpec.Transport("execution", "06 07", "04 05"))
        ServerSocket(0).use { server ->
            server.soTimeout = 3000
            val completed = CompletableFuture<Int>()
            val worker = thread(isDaemon = true) {
                try {
                    server.accept().use { socket ->
                        socket.soTimeout = 3000
                        repeat(2) {
                            assertThat(Framer.readFrame(socket.getInputStream(), protocol, Direction.SEND)!!.bytes).isEqualTo(request)
                            socket.getOutputStream().write(6); socket.getOutputStream().flush()
                            socket.getOutputStream().write(byteArrayOf(7) + "0008PONG".toByteArray()); socket.getOutputStream().flush()
                            assertThat(socket.getInputStream().readNBytes(2)).isEqualTo(byteArrayOf(4, 5))
                        }
                        assertThat(socket.getInputStream().read()).isEqualTo(-1)
                        completed.complete(2)
                    }
                } catch (e: Throwable) { completed.completeExceptionally(e) }
            }
            try {
                TcpClient.Session("127.0.0.1", server.localPort, 2000).use { session ->
                    repeat(2) {
                        val result = session.exchange(request, protocol)
                        assertThat(String(result.response.bytes)).isEqualTo("0008PONG")
                        assertThat(result.requestAck).isEqualTo(byteArrayOf(6, 7))
                        assertThat(result.responseAck).isEqualTo(byteArrayOf(4, 5))
                        assertThat(session.isClosed).isFalse()
                    }
                }
                assertThat(completed.get(4, TimeUnit.SECONDS)).isEqualTo(2)
            } finally { server.close(); worker.join(1000) }
        }
    }

    @Test fun `단발 호출과 별도 세션은 연결을 공유하지 않는다`() {
        ServerSocket(0).use { server ->
            server.soTimeout = 3000
            val completed = CompletableFuture<Int>()
            val worker = thread(isDaemon = true) {
                try {
                    repeat(2) {
                        server.accept().use { socket ->
                            socket.soTimeout = 3000
                            assertThat(Framer.readFrame(socket.getInputStream(), spec, Direction.SEND)!!.bytes).isEqualTo(request)
                            socket.getOutputStream().write("0008PONG".toByteArray()); socket.getOutputStream().flush()
                            assertThat(socket.getInputStream().read()).isEqualTo(-1)
                        }
                    }
                    completed.complete(2)
                } catch (e: Throwable) { completed.completeExceptionally(e) }
            }
            try {
                repeat(2) { TcpClient.exchange("127.0.0.1", server.localPort, 2000, request, spec) }
                assertThat(completed.get(4, TimeUnit.SECONDS)).isEqualTo(2)
            } finally { server.close(); worker.join(1000) }
        }
    }

    @Test fun `ACK 불일치는 연결을 닫고 같은 요청을 다시 보내지 않는다`() {
        val protocol = spec.copy(transport = ProtocolSpec.Transport("execution", "06", "06"))
        ServerSocket(0).use { server ->
            server.soTimeout = 3000
            val completed = CompletableFuture<Int>()
            val worker = thread(isDaemon = true) {
                try {
                    server.accept().use { socket ->
                        socket.soTimeout = 3000
                        Framer.readFrame(socket.getInputStream(), protocol, Direction.SEND)!!
                        socket.getOutputStream().write(21); socket.getOutputStream().flush()
                        completed.complete(socket.getInputStream().read())
                    }
                } catch (e: Throwable) { completed.completeExceptionally(e) }
            }
            try {
                TcpClient.Session("127.0.0.1", server.localPort, 2000).use { session ->
                    assertThatThrownBy { session.exchange(request, protocol) }.isInstanceOf(IOException::class.java).hasMessageContaining("요청 ACK")
                    assertThat(session.isClosed).isTrue()
                    assertThatThrownBy { session.exchange(request, protocol) }.hasMessageContaining("자동 재전송하지 않습니다")
                }
                assertThat(completed.get(4, TimeUnit.SECONDS)).isEqualTo(-1)
            } finally { server.close(); worker.join(1000) }
        }
    }

    @Test fun `응답 타임아웃은 연결을 닫고 재전송하지 않는다`() {
        ServerSocket(0).use { server ->
            server.soTimeout = 3000
            val completed = CompletableFuture<Int>()
            val worker = thread(isDaemon = true) {
                try {
                    server.accept().use { socket ->
                        socket.soTimeout = 3000
                        Framer.readFrame(socket.getInputStream(), spec, Direction.SEND)!!
                        completed.complete(socket.getInputStream().read())
                    }
                } catch (e: Throwable) { completed.completeExceptionally(e) }
            }
            try {
                TcpClient.Session("127.0.0.1", server.localPort, 2000).use { session ->
                    assertThatThrownBy { session.exchange(request, spec, 100) }.isInstanceOf(SocketTimeoutException::class.java)
                    assertThat(session.isClosed).isTrue()
                    assertThatThrownBy { session.exchange(request, spec) }.hasMessageContaining("자동 재전송하지 않습니다")
                }
                assertThat(completed.get(4, TimeUnit.SECONDS)).isEqualTo(-1)
            } finally { server.close(); worker.join(1000) }
        }
    }

    @Test fun `실제 Mock과 프록시는 서로 다른 요청 응답 프레이밍과 4-way 유지 연결을 함께 처리한다`() {
        val variants = listOf(
            spec.copy(responseFraming = ProtocolSpec.Framing("fixed", fixedLength = 8)),
            spec.copy(framing = ProtocolSpec.Framing("delimiter", delimiterHex = "0D0A"),
                responseFraming = ProtocolSpec.Framing("fixed", fixedLength = 8)),
            spec.copy(lengthFormat = "ascii-hex", framing = ProtocolSpec.Framing("length", lengthAdjustment = 4),
                responseFraming = ProtocolSpec.Framing("delimiter", delimiterHex = "0A")),
        )
        for (variant in variants) {
            val protocol = variant.copy(transport = ProtocolSpec.Transport("execution", "06", "06"))
            ServerSocket(0).use { upstream -> ServerSocket(0).use { proxy ->
                upstream.soTimeout = 3000; proxy.soTimeout = 3000
                val upstreamLogs = java.util.concurrent.CopyOnWriteArrayList<MockRuntimeStore.TcpLogEntry>()
                val proxyLogs = java.util.concurrent.CopyOnWriteArrayList<MockRuntimeStore.TcpLogEntry>()
                val upstreamDone = CompletableFuture<Unit>()
                val proxyDone = CompletableFuture<Unit>()
                val targetWorker = thread(isDaemon = true) {
                    try {
                        upstream.accept().use { socket ->
                            socket.soTimeout = 3000
                            mock(protocol, upstreamLogs, false).serve(socket.getInputStream(), socket.getOutputStream()) { socket.close() }
                        }; upstreamDone.complete(Unit)
                    } catch (e: Throwable) { upstreamDone.completeExceptionally(e) }
                }
                val proxyWorker = thread(isDaemon = true) {
                    try {
                        proxy.accept().use { socket ->
                            socket.soTimeout = 3000
                            val session = mock(protocol, proxyLogs, true) {
                                val peer = java.net.Socket("127.0.0.1", upstream.localPort).apply { soTimeout = 3000 }
                                TcpMockSession.Upstream(peer.getInputStream(), peer.getOutputStream()) { peer.close() }
                            }
                            session.serve(socket.getInputStream(), socket.getOutputStream()) { socket.close() }
                        }; proxyDone.complete(Unit)
                    } catch (e: Throwable) { proxyDone.completeExceptionally(e) }
                }
                try {
                    TcpClient.Session("127.0.0.1", proxy.localPort, 2000).use { client ->
                        repeat(2) {
                            val encoded = ProtocolCodec.encode(protocol, "request", mapOf("value" to "PING"))
                            val response = client.exchange(encoded.bytes, protocol).response
                            assertThat(ProtocolCodec.decode(protocol, response.bytes, Direction.RECV).body!!["value"]).isEqualTo("PONG")
                        }
                    }
                    proxyDone.get(4, TimeUnit.SECONDS); upstreamDone.get(4, TimeUnit.SECONDS)
                    assertThat(upstreamLogs.count { it.note == "요청 ACK" }).isEqualTo(2)
                    assertThat(upstreamLogs.count { it.note == "응답 ACK" }).isEqualTo(2)
                    assertThat(proxyLogs.count { it.note == "upstream 요청 ACK" }).isEqualTo(2)
                    assertThat(proxyLogs.count { it.note == "upstream 응답 ACK" }).isEqualTo(2)
                    assertThat((upstreamLogs + proxyLogs).none { it.level == "error" }).isTrue()
                } finally { proxy.close(); upstream.close(); targetWorker.join(1000); proxyWorker.join(1000) }
            } }
        }
    }

    private fun mock(protocol: ProtocolSpec, logs: MutableList<MockRuntimeStore.TcpLogEntry>, proxy: Boolean,
                     upstream: () -> TcpMockSession.Upstream? = { null }): TcpMockSession {
        val rules = listOf(MockSpec.MockTcpRule("r", then = if (proxy) MockSpec.MockTcpThen("proxy") else MockSpec.MockTcpThen("mock", mapOf("value" to "PONG"))))
        return TcpMockSession(protocol, MockSpec.MockTcp(9000, "p", rules = rules), ProtocolCodec.NO_PLUGINS,
            emptyMap(), { 1L }, { logs.add(it) }, upstream)
    }
}
