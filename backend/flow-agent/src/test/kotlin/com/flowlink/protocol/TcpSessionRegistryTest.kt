package com.flowlink.protocol

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class TcpSessionRegistryTest {
    private val spec = ProtocolSpec(encoding = "UTF-8", framing = ProtocolSpec.Framing(mode = "fixed", fixedLength = 3))
    private fun scope(id: UUID = UUID.randomUUID(), owner: String = "alice") = TcpSessionRegistry.Scope(id, "tenant", listOf(owner), "public", "server", owner)

    private class Peer : AutoCloseable {
        val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        val accepts = AtomicInteger()
        val requests = AtomicInteger()
        private val workers = Executors.newVirtualThreadPerTaskExecutor()
        init { workers.submit {
            try { while (!server.isClosed) {
                val socket = server.accept(); accepts.incrementAndGet()
                workers.submit { socket.use { s ->
                    try { while (s.getInputStream().readNBytes(3).size == 3) {
                        requests.incrementAndGet(); s.getOutputStream().write("YES".toByteArray()); s.getOutputStream().flush()
                    } } catch (_: Exception) { }
                } }
            } } catch (_: Exception) { }
        } }
        override fun close() { server.close(); workers.shutdownNow(); workers.awaitTermination(2, TimeUnit.SECONDS) }
    }

    @Test fun `one execution reuses one connection while execution and owner boundaries stay isolated`() {
        Peer().use { peer -> TcpSessionRegistry().use { registry ->
            val owner = scope()
            fun exchange(who: TcpSessionRegistry.Scope) = registry.exchange(who, "127.0.0.1", peer.server.localPort, 1000, "REQ".toByteArray(), spec, "v1")
            assertThat(exchange(owner).reused).isFalse()
            assertThat(exchange(owner).reused).isTrue()
            assertThat(exchange(scope(owner.executionId, "bob")).reused).isFalse()
            assertThat(exchange(scope()).reused).isFalse()
            assertThat(peer.accepts.get()).isEqualTo(3)
            assertThat(peer.requests.get()).isEqualTo(4)
        } }
    }

    @Test fun `idle expiration fails before sending another request instead of reconnecting`() {
        Peer().use { peer -> TcpSessionRegistry(idleMs = 0).use { registry ->
            val owner = scope()
            registry.exchange(owner, "127.0.0.1", peer.server.localPort, 1000, "REQ".toByteArray(), spec, "v1")
            registry.expireIdle()
            assertThatThrownBy { registry.exchange(owner, "127.0.0.1", peer.server.localPort, 1000, "REQ".toByteArray(), spec, "v1") }
                .hasMessageContaining("재전송하지 않았습니다")
            assertThat(peer.accepts.get()).isEqualTo(1)
            assertThat(peer.requests.get()).isEqualTo(1)
        } }
    }

    @Test fun `capacity rejects before sending and terminal cleanup releases capacity`() {
        Peer().use { peer -> TcpSessionRegistry(maxEntries = 1).use { registry ->
            val owner = scope(); val next = scope()
            fun exchange(who: TcpSessionRegistry.Scope) = registry.exchange(who, "127.0.0.1", peer.server.localPort, 1000, "REQ".toByteArray(), spec, "v1")
            exchange(owner)
            assertThatThrownBy { exchange(next) }.hasMessageContaining("상한")
            registry.closeExecution(owner.executionId, owner.tenant, owner.owner)
            assertThat(exchange(next).reused).isFalse()
            assertThat(peer.accepts.get()).isEqualTo(2)
            assertThat(peer.requests.get()).isEqualTo(2)
        } }
    }

    @Test fun `protocol idle limit overrides the registry default and validates its range`() {
        val configured = spec.copy(transport = ProtocolSpec.Transport(connection = "execution", idleTimeoutMs = 5000))
        assertThat(configured.validate()).isEmpty()
        assertThat(configured.copy(transport = configured.transport!!.copy(idleTimeoutMs = 999)).validate()).isNotEmpty()
        assertThat(configured.copy(transport = configured.transport!!.copy(idleTimeoutMs = 3_600_001)).validate()).isNotEmpty()
        Peer().use { peer -> TcpSessionRegistry(idleMs = 0).use { registry ->
            val owner = scope()
            registry.exchange(owner, "127.0.0.1", peer.server.localPort, 1000, "REQ".toByteArray(), configured, "v1")
            registry.expireIdle()
            assertThat(registry.exchange(owner, "127.0.0.1", peer.server.localPort, 1000, "REQ".toByteArray(), configured, "v1").reused).isTrue()
        } }
    }

    @Test fun `cancellation closes a socket blocked waiting for a response`() {
        ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { server ->
            Executors.newVirtualThreadPerTaskExecutor().use { workers -> TcpSessionRegistry().use { registry ->
                val received = CountDownLatch(1); val owner = scope()
                val peer = workers.submit<Int> { server.accept().use { s ->
                    s.soTimeout = 3000; s.getInputStream().readNBytes(3); received.countDown(); s.getInputStream().read()
                } }
                val request = workers.submit<TcpSessionRegistry.Result> { registry.exchange(owner, "127.0.0.1", server.localPort, 3000, "REQ".toByteArray(), spec, "v1") }
                assertThat(received.await(2, TimeUnit.SECONDS)).isTrue()
                registry.closeExecution(owner.executionId, owner.tenant, owner.owner)
                assertThatThrownBy { request.get(2, TimeUnit.SECONDS) }.hasCauseInstanceOf(java.io.IOException::class.java)
                assertThat(peer.get(2, TimeUnit.SECONDS)).isEqualTo(-1)
                assertThatThrownBy { registry.exchange(owner, "127.0.0.1", server.localPort, 1000, "REQ".toByteArray(), spec, "v1") }
                    .isInstanceOf(TcpSessionRegistry.NotSentException::class.java)
            } }
        }
    }

    @Test fun `cancellation during preparation and another owner remain separate`() {
        Peer().use { peer -> TcpSessionRegistry().use { registry ->
            val owner = scope()
            registry.closeExecution(owner.executionId, owner.tenant, owner.owner)
            assertThatThrownBy { registry.exchange(owner, "127.0.0.1", peer.server.localPort, 1000, "REQ".toByteArray(), spec, "v1") }
                .isInstanceOf(TcpSessionRegistry.NotSentException::class.java)
            val other = scope(owner.executionId, "bob")
            registry.exchange(other, "127.0.0.1", peer.server.localPort, 1000, "REQ".toByteArray(), spec, "v1")
            assertThat(peer.requests.get()).isEqualTo(1)
            assertThat(peer.accepts.get()).isEqualTo(1)
        } }
    }
}
