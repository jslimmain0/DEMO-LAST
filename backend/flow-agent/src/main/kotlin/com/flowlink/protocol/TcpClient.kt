package com.flowlink.protocol

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import com.flowlink.common.tcp.TcpBytes
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException

/** 단발 또는 실행 소유 연결에서 전문을 왕복한다. 실패한 요청을 자동으로 재전송하지 않는다. */
object TcpClient {
    data class Step(val phase: String, val role: String, val direction: String?, val expectedBytes: Int?, val actualBytes: Int, val transactionKey: String?, val durationMs: Long, val status: String, val validationMode: String? = null, val errorCode: String? = null)
    class Exchange(val response: Framer.Frame, val elapsedMs: Long, val requestAck: ByteArray? = null, val responseAck: ByteArray? = null, val transactionKey: String? = null, val steps: List<Step> = emptyList())
    class ExchangeException(val code: String, val phase: String, val expectedBytes: Int?, val actualBytes: Int, val steps: List<Step>, val response: Framer.Frame?, cause: Throwable) : IOException("$phase: $code ($actualBytes/${expectedBytes ?: "?"}B)", cause)

    class Session(private val host: String, private val port: Int, private val timeoutMs: Int) : AutoCloseable {
        private val socket = Socket()
        private var input: InputStream? = null
        @Volatile private var closed = false
        val isClosed: Boolean get() = closed || socket.isClosed

        @Synchronized
        fun exchange(request: ByteArray, spec: ProtocolSpec, timeoutMs: Int = this.timeoutMs, beforeSend: () -> Boolean = { true }, plugins: ProtocolCodec.PluginLookup = ProtocolCodec.NO_PLUGINS, resolve: (String) -> String = { it }): Exchange {
            if (isClosed) throw IOException("TCP 연결이 종료되었습니다. 실패한 요청은 자동 재전송하지 않습니다.")
            return try {
                if (!socket.isConnected) {
                    socket.connect(InetSocketAddress(host, port), timeout(timeoutMs))
                    input = socket.getInputStream().buffered()
                }
                socket.soTimeout = timeout(timeoutMs)
                TcpClient.exchange(input!!, socket.getOutputStream(), request, spec, beforeSend, plugins, resolve) { socket.soTimeout = it ?: timeout(timeoutMs) }
            } catch (e: Exception) { close(); throw e }
        }

        override fun close() { closed = true; runCatching { socket.close() } }
    }

    fun exchange(host: String, port: Int, timeoutMs: Int, request: ByteArray, spec: ProtocolSpec, beforeSend: () -> Boolean = { true }, plugins: ProtocolCodec.PluginLookup = ProtocolCodec.NO_PLUGINS, resolve: (String) -> String = { it }): Exchange {
        return Session(host, port, timeoutMs).use { it.exchange(request, spec, beforeSend = beforeSend, plugins = plugins, resolve = resolve) }
    }

    /** Proxy도 각 연결의 ACK를 확인한다. 스트림 소유자는 실패 시 연결을 닫아야 한다. */
    fun exchange(input: InputStream, output: OutputStream, request: ByteArray, spec: ProtocolSpec, beforeSend: () -> Boolean = { true }, plugins: ProtocolCodec.PluginLookup = ProtocolCodec.NO_PLUGINS, resolve: (String) -> String = { it }, ackTimeout: (Int?) -> Unit = {}): Exchange {
        if (spec.schemaVersion == 2) return exchangeV2(input, output, request, spec, beforeSend, plugins, resolve, ackTimeout)
        val requestAck = ackBytes(spec.transport?.requestAckHex)
        val responseAck = ackBytes(spec.transport?.responseAckHex)
        val t0 = System.nanoTime()
        if (!beforeSend()) throw TcpSessionRegistry.NotSentException(TcpSessionRegistry.SEND_CANCELLED)
        output.write(request); output.flush()
        requestAck?.let { readAck(input, it, "요청 ACK") }
        val frame = Framer.readFrame(input, spec, Direction.RECV) ?: throw IOException("응답 없이 연결이 닫혔습니다.")
        responseAck?.let { output.write(it); output.flush() }
        return Exchange(frame, (System.nanoTime() - t0) / 1_000_000, requestAck, responseAck)
    }

    private fun exchangeV2(input: InputStream, output: OutputStream, request: ByteArray, spec: ProtocolSpec, beforeSend: () -> Boolean, plugins: ProtocolCodec.PluginLookup, resolve: (String) -> String, ackTimeout: (Int?) -> Unit): Exchange {
        val plan = ProtocolCompiler.compile(spec)
        val transaction = plan.select(ProtocolCompiler.header(spec, request, plugins, resolve))
        val requestValues = ProtocolCompiler.parse(spec, request, transactionKey = transaction.key, plugins = plugins, resolve = resolve).values
        val effective = plan.effectiveSpec(transaction)
        val steps = ArrayList<Step>()
        val start = System.nanoTime()
        var phase = "REQUEST"
        var expected: Int? = request.size
        var actual = 0
        var response: Framer.Frame? = null
        var phaseStart = start
        var requestAck: ByteArray? = null
        var responseAck: ByteArray? = null
        fun record(status: String, direction: String?, mode: String? = null, code: String? = null) { steps += Step(phase, "client", direction, expected, actual, transaction.key, (System.nanoTime() - phaseStart) / 1_000_000, status, mode, code) }
        fun begin(next: String, length: Int?) { phase = next; expected = length; actual = 0; phaseStart = System.nanoTime() }
        try {
            if (!beforeSend()) throw TcpSessionRegistry.NotSentException(TcpSessionRegistry.SEND_CANCELLED)
            output.write(request); output.flush(); actual = request.size; record("SUCCEEDED", "SEND")
            begin("REQUEST_ACK", transaction.requestAck?.let { ProtocolCompiler.ackLength(spec, it) })
            if (transaction.requestAck == null) record("SKIPPED", null) else {
                val ack = transaction.requestAck
                ackTimeout(ack.timeoutMs)
                try { requestAck = receiveAck(input, spec, ack, requestValues, emptyMap(), plugins, resolve) { ackTimeout(it) }; actual = requestAck.size }
                finally { ackTimeout(null) }
                record("SUCCEEDED", "RECEIVE", ack.receive?.kind)
            }
            begin("RESPONSE", effective.framingFor(Direction.RECV)?.fixedLength)
            response = Framer.readFrame(input, effective, Direction.RECV) ?: throw java.io.EOFException("응답 전에 연결이 종료되었습니다.")
            actual = response.bytes.size
            val responseValues = ProtocolCompiler.parse(spec, response.bytes, transactionKey = transaction.key, phase = "response", requestFields = requestValues, plugins = plugins, resolve = resolve).values
            record("SUCCEEDED", "RECEIVE")
            begin("RESPONSE_ACK", transaction.responseAck?.let { ProtocolCompiler.ackLength(spec, it) })
            if (transaction.responseAck == null) record("SKIPPED", null) else {
                responseAck = ProtocolCompiler.assembleAck(spec, transaction.responseAck, requestValues, responseValues, plugins, resolve).bytes
                output.write(responseAck); output.flush(); actual = responseAck.size
                record("SUCCEEDED", "SEND", transaction.responseAck.send?.kind)
            }
            begin("COMPLETE", null); record("SUCCEEDED", null)
            return Exchange(response, (System.nanoTime() - start) / 1_000_000, requestAck, responseAck, transaction.key, steps)
        } catch (e: TcpSessionRegistry.NotSentException) { throw e }
        catch (e: Exception) {
            if (e is AckException) actual = e.bytes.size
            if (e is Framer.FrameException) { actual = e.raw?.size ?: 0; expected = e.expectedBytes ?: expected }
            val code = when (e) { is AckException -> e.code; is Framer.FrameException -> e.code ?: "FRAME_ERROR"; is SocketTimeoutException -> if (phase.endsWith("ACK")) "ACK_TIMEOUT" else "FRAME_TIMEOUT"; is java.io.EOFException -> "FRAME_EOF"; is ProtocolCompiler.ProtocolFailure -> e.code; else -> "FRAME_ERROR" }
            record("FAILED", if (phase == "REQUEST" || phase == "RESPONSE_ACK") "SEND" else "RECEIVE", code = code)
            throw ExchangeException(code, phase, expected, actual, steps.toList(), response, e)
        }
    }

    class AckException(val code: String, val bytes: ByteArray, val expectedBytes: Int, cause: Throwable? = null) : IOException("$code (${bytes.size}/${expectedBytes}B)", cause)
    fun receiveAck(input: InputStream, spec: ProtocolSpec, ack: ProtocolSpec.Ack, request: Map<String, String>, response: Map<String, String>, plugins: ProtocolCodec.PluginLookup = ProtocolCodec.NO_PLUGINS, resolve: (String) -> String = { it }, beforeRead: (Int) -> Unit = {}): ByteArray {
        val length = ProtocolCompiler.ackLength(spec, ack)
        val bytes = ByteArray(length)
        var received = 0
        val deadline = System.nanoTime() + (ack.timeoutMs ?: 5000).toLong() * 1_000_000
        try {
            while (received < length) {
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0) throw AckException("ACK_TIMEOUT", bytes.copyOf(received), length)
                beforeRead(maxOf(1, (remaining / 1_000_000).toInt()))
                val count = input.read(bytes, received, length - received)
                if (count < 0) throw AckException("ACK_EOF", bytes.copyOf(received), length)
                if (count == 0) throw AckException("ACK_NO_PROGRESS", bytes.copyOf(received), length)
                received += count
            }
        } catch (e: SocketTimeoutException) { throw AckException("ACK_TIMEOUT", bytes.copyOf(received), length, e) }
        catch (e: AckException) { throw e }
        catch (e: IOException) { throw AckException("ACK_IO", bytes.copyOf(received), length, e) }
        try { ProtocolCompiler.validateAck(spec, ack, bytes, request, response, plugins, resolve) }
        catch (e: Exception) { throw AckException(if (e is ProtocolCompiler.ProtocolFailure) e.code else "ACK_MISMATCH", bytes, length, e) }
        return bytes
    }

    internal fun ackBytes(hex: String?): ByteArray? {
        if (hex.isNullOrBlank()) return null
        val bytes = TcpBytes.hexToBytes(hex) ?: throw IOException("ACK는 HEX 바이트로 입력하세요.")
        if (bytes.isEmpty() || bytes.size > 1024) throw IOException("ACK 길이는 1~1024바이트여야 합니다.")
        return bytes
    }

    internal fun readAck(input: InputStream, expected: ByteArray, label: String): ByteArray {
        val bytes = input.readNBytes(expected.size)
        if (bytes.size != expected.size) throw IOException("$label 수신 중 연결이 종료되었습니다 (${bytes.size}/${expected.size}B).")
        if (!bytes.contentEquals(expected)) throw IOException("$label 값이 설정과 다릅니다.")
        return bytes
    }

    private fun timeout(value: Int): Int = if (value <= 0) 5000 else value
}
