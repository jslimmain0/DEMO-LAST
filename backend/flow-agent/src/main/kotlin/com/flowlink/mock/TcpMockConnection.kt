package com.flowlink.mock

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.NotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.net.SocketTimeoutException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

/** 짧은 socket read timeout을 내부에서 이어 읽어 관리자가 대기 중 유휴 기한을 바꿔도 부분 전문을 보존한다. */
internal class TcpMockConnection(val socket: Socket) {
    val id: UUID = UUID.randomUUID()
    private val connectedAt = Instant.now()
    private var lastActivityAt = connectedAt
    private var idleTimeoutMs = 30_000
    private var deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(idleTimeoutMs.toLong())
    private var state = "starting"
    private var receivedMessages = 0L
    private var closed = false
    @Volatile private var expired = false

    @Synchronized fun configure(timeoutMs: Int) { idleTimeoutMs = timeoutMs; resetDeadline() }
    @Synchronized fun waiting() { if (!closed) { state = "waiting"; resetDeadline() } }
    @Synchronized fun received() { if (!closed) { state = "processing"; receivedMessages++ } }
    @Synchronized private fun activity() { lastActivityAt = Instant.now(); resetDeadline() }
    private fun resetDeadline() { deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(idleTimeoutMs.toLong()) }

    @Synchronized fun close() { closed = true; runCatching { socket.close() } }

    @Synchronized fun view(): TcpMockListenerRuntime.SessionView? {
        if (closed || socket.isClosed) return null
        val now = System.nanoTime()
        if (state == "waiting" && deadline <= now) { expire(); return null }
        val remainingNanos = if (state == "waiting") maxOf(0, deadline - now) else null
        return TcpMockListenerRuntime.SessionView(id, socket.inetAddress.hostAddress, socket.port,
            connectedAt, lastActivityAt, idleTimeoutMs, state,
            remainingNanos?.let { Instant.now().plusNanos(it) },
            remainingNanos?.let { TimeUnit.NANOSECONDS.toMillis(it) }, receivedMessages)
    }

    @Synchronized fun extend(extendMs: Int): TcpMockListenerRuntime.SessionView {
        if (closed || socket.isClosed || state == "waiting" && deadline <= System.nanoTime()) {
            if (!closed && !socket.isClosed) expire()
            throw NotFoundException("TCP Mock 연결이 이미 종료되었거나 만료되었습니다.")
        }
        if (state != "waiting") throw BadRequestException("다음 전문을 기다리는 연결만 유휴 기한을 연장할 수 있습니다.")
        val now = System.nanoTime()
        val extended = deadline + TimeUnit.MILLISECONDS.toNanos(extendMs.toLong())
        if (extended - now > TimeUnit.HOURS.toNanos(1)) throw BadRequestException("연장 후 남은 유휴 기한은 1시간을 넘을 수 없습니다.")
        deadline = extended
        return view() ?: throw NotFoundException("TCP Mock 연결이 이미 종료되었습니다.")
    }

    @Synchronized private fun readTimeout(): Int {
        if (expired) throw idleExpired()
        if (closed || socket.isClosed) throw IOException("TCP 연결이 종료되었습니다.")
        val remaining = deadline - System.nanoTime()
        if (remaining <= 0) {
            expire()
            throw idleExpired()
        }
        return minOf(200L, maxOf(1L, (remaining + 999_999) / 1_000_000)).toInt()
    }

    private fun expire() { expired = true; close() }
    private fun idleExpired() = SocketTimeoutException("유휴 기한 경과 — 연결 종료")

    fun input(): InputStream = object : InputStream() {
        private val delegate = socket.getInputStream()
        private val single = ByteArray(1)
        override fun read(): Int = if (read(single, 0, 1) < 0) -1 else single[0].toInt() and 0xff
        override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            while (true) {
                socket.soTimeout = readTimeout()
                val count = try { delegate.read(bytes, offset, length) }
                    catch (_: SocketTimeoutException) { continue }
                    catch (e: IOException) { if (expired) throw idleExpired(); throw e }
                if (count > 0) activity()
                return count
            }
        }
    }.buffered()

    fun output(): OutputStream = object : OutputStream() {
        private val delegate = socket.getOutputStream()
        override fun write(value: Int) { delegate.write(value); activity() }
        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            delegate.write(bytes, offset, length)
            if (length > 0) activity()
        }
        override fun flush() = delegate.flush()
    }
}
