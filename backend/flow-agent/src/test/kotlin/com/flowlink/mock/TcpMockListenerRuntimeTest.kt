package com.flowlink.mock

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.NotFoundException
import com.flowlink.plugin.PluginsProperties
import com.flowlink.protocol.ProtocolSpec
import com.flowlink.transform.TransformRegistry
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class TcpMockListenerRuntimeTest {
    private fun protocol(ack: Boolean = false) = ProtocolSpec(
        encoding = "US-ASCII", framing = ProtocolSpec.Framing("fixed", fixedLength = 4),
        messages = listOf(
            ProtocolSpec.Message("request", fields = listOf(ProtocolSpec.Field("value", 4, "ascii"))),
            ProtocolSpec.Message("response", fields = listOf(ProtocolSpec.Field("value", 4, "ascii"))),
        ), transport = ProtocolSpec.Transport(requestAckHex = if (ack) "06" else null,
            responseAckHex = if (ack) "06" else null, idleTimeoutMs = 1000),
    )

    private class Fixture(
        val protocol: ProtocolSpec,
        val fault: MockSpec.MockTcpFault? = null,
        loader: MockScopeLoader = MockScopeLoader { _, _, _ -> MockSecretProvider.Scope(emptyMap(), emptyMap()) },
    ) : AutoCloseable {
        val mockId = UUID.randomUUID()
        val protocolId = UUID.randomUUID()
        val port = ServerSocket(0).use { it.localPort }
        val store = MockRuntimeStore()
        val runtime = TcpMockListenerRuntime(TransformRegistry(PluginsProperties("build/tmp/no-plugins", false)), store,
            MockSecretProvider(loader), "127.0.0.1")
        val tcp = MockSpec.MockTcp(port, protocolId.toString(), rules = listOf(
            MockSpec.MockTcpRule("echo", then = MockSpec.MockTcpThen("mock", mapOf("value" to "{{req.value}}")), fault = fault),
        ))
        val snapshot = MockServingSnapshot(mockId, "test-tenant", null, "tcp-session-test", null, true)
        private val peers = ArrayList<Socket>()
        init { runtime.sync(snapshot, tcp, protocol, null) }
        fun connect(): Socket = Socket("127.0.0.1", port).apply { soTimeout = 4000; peers += this }
        fun view(peer: Socket): TcpMockListenerRuntime.SessionView = runtime.sessions(mockId).single { it.remotePort == peer.localPort }
        fun waitWaiting(peer: Socket): TcpMockListenerRuntime.SessionView {
            await { runtime.sessions(mockId).any { it.remotePort == peer.localPort && it.state == "waiting" } }
            return view(peer)
        }
        override fun close() { peers.forEach { it.close() }; runtime.stopAll() }
    }

    @Test
    fun `blocked waiting connection can be extended while another expires and next request resets its default idle`() {
        Fixture(protocol()).use { f ->
            val kept = f.connect(); val expired = f.connect()
            val initial = f.waitWaiting(kept); f.waitWaiting(expired)
            val extended = f.runtime.extendSession(f.mockId, initial.id, 2000)
            assertThat(extended.remainingMs!!).isGreaterThan(2500)
            assertThat(extended.expiresAt).isAfter(initial.expiresAt)
            Thread.sleep(1200)
            assertThat(expired.getInputStream().read()).isEqualTo(-1)
            exchange(kept, "A001")
            val reset = f.waitWaiting(kept)
            assertThat(reset.id).isEqualTo(initial.id)
            assertThat(reset.receivedMessages).isEqualTo(1)
            assertThat(reset.remainingMs!!).isBetween(700L, 1000L)
            assertThat(reset.lastActivityAt).isAfter(initial.lastActivityAt)
            Thread.sleep(1100)
            assertThat(kept.getInputStream().read()).isEqualTo(-1)
            await { f.runtime.sessions(f.mockId).isEmpty() }
            assertThatThrownBy { f.runtime.extendSession(f.mockId, initial.id, 1000) }.isInstanceOf(NotFoundException::class.java)
            assertThat(f.store.tcpLog(f.mockId).filter { it.note == "유휴 기한 경과 — 연결 종료" }).hasSize(2)
        }
    }

    @Test
    fun `extension keeps partially read frame and counts complete messages only`() {
        Fixture(protocol()).use { f ->
            val peer = f.connect(); val initial = f.waitWaiting(peer)
            peer.getOutputStream().write("A0".toByteArray()); peer.getOutputStream().flush()
            await { f.view(peer).lastActivityAt > initial.lastActivityAt }
            assertThat(f.view(peer).receivedMessages).isZero()
            f.runtime.extendSession(f.mockId, initial.id, 1500)
            Thread.sleep(1200)
            peer.getOutputStream().write("01".toByteArray()); peer.getOutputStream().flush()
            assertThat(String(peer.getInputStream().readNBytes(4))).isEqualTo("A001")
            assertThat(f.waitWaiting(peer).receivedMessages).isEqualTo(1)
            exchange(peer, "B002")
            assertThat(f.waitWaiting(peer).receivedMessages).isEqualTo(2)
        }
    }

    @Test
    fun `extension preserves partial delimiter and buffered consecutive frames`() {
        Fixture(protocol().copy(framing = ProtocolSpec.Framing("delimiter", delimiterHex = "0d0a"))).use { f ->
            val peer = f.connect(); val initial = f.waitWaiting(peer)
            peer.getOutputStream().write("A001\r".toByteArray()); peer.getOutputStream().flush()
            await { f.view(peer).lastActivityAt > initial.lastActivityAt }
            f.runtime.extendSession(f.mockId, initial.id, 1500)
            Thread.sleep(1200)
            peer.getOutputStream().write('\n'.code); peer.getOutputStream().flush()
            assertThat(String(peer.getInputStream().readNBytes(6))).isEqualTo("A001\r\n")
            peer.getOutputStream().write("B002\r\nC003\r\n".toByteArray()); peer.getOutputStream().flush()
            assertThat(String(peer.getInputStream().readNBytes(12))).isEqualTo("B002\r\nC003\r\n")
            assertThat(f.waitWaiting(peer).receivedMessages).isEqualTo(3)
        }
    }

    @Test
    fun `response transmission and response ACK reset idle and processing connections reject extension`() {
        Fixture(protocol(ack = true), MockSpec.MockTcpFault(delayMs = 600)).use { f ->
            val peer = f.connect(); val initial = f.waitWaiting(peer)
            peer.getOutputStream().write("A001".toByteArray()); peer.getOutputStream().flush()
            assertThat(peer.getInputStream().read()).isEqualTo(6)
            assertThat(String(peer.getInputStream().readNBytes(4))).isEqualTo("A001")
            val processing = f.view(peer)
            assertThat(processing.state).isEqualTo("processing")
            assertThat(processing.remainingMs).isNull()
            assertThat(processing.expiresAt).isNull()
            assertThatThrownBy { f.runtime.extendSession(f.mockId, initial.id, 1000) }.isInstanceOf(BadRequestException::class.java)
            Thread.sleep(600)
            peer.getOutputStream().write(6); peer.getOutputStream().flush()
            val waiting = f.waitWaiting(peer)
            assertThat(waiting.remainingMs!!).isBetween(700L, 1000L)
            assertThat(waiting.lastActivityAt).isAfter(processing.lastActivityAt)
            peer.getOutputStream().write("B002".toByteArray()); peer.getOutputStream().flush()
            assertThat(peer.getInputStream().read()).isEqualTo(6)
            assertThat(String(peer.getInputStream().readNBytes(4))).isEqualTo("B002")
            peer.getOutputStream().write(6); peer.getOutputStream().flush()
            assertThat(f.waitWaiting(peer).receivedMessages).isEqualTo(2)
        }
    }

    @Test
    fun `starting connections and invalid extension bounds fail without changing deadline`() {
        val started = CountDownLatch(1); val release = CountDownLatch(1)
        Fixture(protocol(), loader = MockScopeLoader { _, _, _ ->
            started.countDown(); check(release.await(4, TimeUnit.SECONDS)); MockSecretProvider.Scope(emptyMap(), emptyMap())
        }).use { f ->
            val peer = f.connect()
            try {
                check(started.await(2, TimeUnit.SECONDS))
                val starting = f.view(peer)
                assertThat(starting.state).isEqualTo("starting")
                assertThat(starting.expiresAt).isNull()
                assertThatThrownBy { f.runtime.extendSession(f.mockId, starting.id, 1000) }.isInstanceOf(BadRequestException::class.java)
            } finally { release.countDown() }
            val waiting = f.waitWaiting(peer)
            for (invalid in listOf(999, 3_600_001, 3_600_000)) {
                assertThatThrownBy { f.runtime.extendSession(f.mockId, waiting.id, invalid) }.isInstanceOf(BadRequestException::class.java)
            }
            assertThat(f.view(peer).remainingMs!!).isLessThanOrEqualTo(waiting.remainingMs!!)
            assertThatThrownBy { f.runtime.extendSession(UUID.randomUUID(), waiting.id, 1000) }.isInstanceOf(NotFoundException::class.java)
        }
    }

    @Test
    fun `EOF protocol changes listener updates and stop immediately remove only their active sessions`() {
        Fixture(protocol()).use { f ->
            val eof = f.connect(); val old = f.waitWaiting(eof)
            eof.close()
            await { f.runtime.sessions(f.mockId).isEmpty() }
            assertThatThrownBy { f.runtime.extendSession(f.mockId, old.id, 1000) }.isInstanceOf(NotFoundException::class.java)
            val changed = f.connect(); f.waitWaiting(changed)
            f.runtime.onProtocolChanged(f.protocolId, f.protocol.copy(encoding = "UTF-8"))
            assertThat(f.runtime.sessions(f.mockId)).isEmpty()
            assertThat(changed.getInputStream().read()).isEqualTo(-1)
            val updated = f.connect(); f.waitWaiting(updated)
            f.runtime.sync(f.snapshot, f.tcp.copy(timeoutMs = 6000), f.protocol, null)
            assertThat(f.runtime.sessions(f.mockId)).isEmpty()
            assertThat(updated.getInputStream().read()).isEqualTo(-1)
            val stopped = f.connect(); val current = f.waitWaiting(stopped)
            f.runtime.stop(f.mockId)
            assertThat(f.runtime.sessions(f.mockId)).isEmpty()
            assertThat(stopped.getInputStream().read()).isEqualTo(-1)
            assertThatThrownBy { f.runtime.extendSession(f.mockId, current.id, 1000) }.isInstanceOf(NotFoundException::class.java)
        }
    }

    @Test
    fun `wrong ACK terminates and removes processing session`() {
        Fixture(protocol(ack = true)).use { f ->
            val peer = f.connect(); val initial = f.waitWaiting(peer)
            peer.getOutputStream().write("A001".toByteArray()); peer.getOutputStream().flush()
            assertThat(peer.getInputStream().read()).isEqualTo(6)
            assertThat(String(peer.getInputStream().readNBytes(4))).isEqualTo("A001")
            peer.getOutputStream().write(0x15); peer.getOutputStream().flush()
            assertThat(peer.getInputStream().read()).isEqualTo(-1)
            await { f.runtime.sessions(f.mockId).isEmpty() }
            assertThatThrownBy { f.runtime.extendSession(f.mockId, initial.id, 1000) }.isInstanceOf(NotFoundException::class.java)
        }
    }

    companion object {
        private fun await(condition: () -> Boolean) {
            val limit = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
            while (!condition()) { check(System.nanoTime() < limit) { "TCP session condition timed out" }; Thread.sleep(10) }
        }
        private fun exchange(peer: Socket, text: String) {
            peer.getOutputStream().write(text.toByteArray()); peer.getOutputStream().flush()
            assertThat(String(peer.getInputStream().readNBytes(4))).isEqualTo(text)
        }
    }
}
