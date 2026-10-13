package com.flowlink.protocol

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import com.flowlink.common.tcp.TcpBytes
import java.net.InetSocketAddress
import java.net.Socket

/** 단발 또는 실행 소유 연결에서 전문을 왕복한다. 실패한 요청을 자동으로 재전송하지 않는다. */
object TcpClient {
    class Exchange(val response: Framer.Frame, val elapsedMs: Long, val requestAck: ByteArray? = null, val responseAck: ByteArray? = null)

    class Session(private val host: String, private val port: Int, private val timeoutMs: Int) : AutoCloseable {
        private val socket = Socket()
        private var input: InputStream? = null
        @Volatile private var closed = false
        val isClosed: Boolean get() = closed || socket.isClosed

        @Synchronized
        fun exchange(request: ByteArray, spec: ProtocolSpec, timeoutMs: Int = this.timeoutMs, beforeSend: () -> Boolean = { true }): Exchange {
            if (isClosed) throw IOException("TCP 연결이 종료되었습니다. 실패한 요청은 자동 재전송하지 않습니다.")
            return try {
                if (!socket.isConnected) {
                    socket.connect(InetSocketAddress(host, port), timeout(timeoutMs))
                    input = socket.getInputStream().buffered()
                }
                socket.soTimeout = timeout(timeoutMs)
                TcpClient.exchange(input!!, socket.getOutputStream(), request, spec, beforeSend)
            } catch (e: Exception) { close(); throw e }
        }

        override fun close() { closed = true; runCatching { socket.close() } }
    }

    fun exchange(host: String, port: Int, timeoutMs: Int, request: ByteArray, spec: ProtocolSpec, beforeSend: () -> Boolean = { true }): Exchange {
        return Session(host, port, timeoutMs).use { it.exchange(request, spec, beforeSend = beforeSend) }
    }

    /** Proxy도 각 연결의 ACK를 확인한다. 스트림 소유자는 실패 시 연결을 닫아야 한다. */
    fun exchange(input: InputStream, output: OutputStream, request: ByteArray, spec: ProtocolSpec, beforeSend: () -> Boolean = { true }): Exchange {
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
