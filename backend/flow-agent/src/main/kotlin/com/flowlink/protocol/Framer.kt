package com.flowlink.protocol

import java.io.IOException
import java.io.InputStream
import java.io.ByteArrayOutputStream

/**
 * 스트림에서 전문 1개를 잘라낸다 — 헤더 길이만큼 확보 → 길이 파싱(NaN 이면 원본 바이트 포함 예외) → includes-self 역산 → 나머지 대기.
 * read 한 번 ≠ 전문 하나이므로 청크 크기를 기록하고, 한 단계(헤더/본문)가 여러 read 로 나뉘면 partial=true 로 "부분 수신"을 표시한다.
 */
object Framer {
    const val MAX_FRAME = 1 shl 20

    /** partial = 헤더나 본문 중 한 단계라도 read 를 여러 번 해야 다 받은 경우(청크 2개 ≠ 부분 수신 — 단계마다 최소 1개). */
    class Frame(val bytes: ByteArray, val chunks: List<Int>, val partial: Boolean, val transactionKey: String? = null)
    class FrameException(message: String, val raw: ByteArray?, val code: String? = null, val expectedBytes: Int? = null) : IOException(message)

    /** null = 바이트 0 에서 깨끗한 EOF(상대가 닫음). */
    fun readFrame(input: InputStream, spec: ProtocolSpec, direction: Direction = Direction.RECV, onSelected: (String?, Int?) -> Unit = { _, _ -> }): Frame? {
        if (spec.schemaVersion == 2 && direction == Direction.SEND && !spec.transactions.isNullOrEmpty()) {
            val plan = ProtocolCompiler.compile(spec)
            val chunks = ArrayList<Int>()
            val header = readExactly(input, spec.headerLen(), chunks, allowEmptyEof = true, captureErrors = true) ?: return null
            val transaction = try { plan.select(ProtocolCompiler.header(spec, header, selectionOnly = true)) } catch (e: Exception) { throw FrameException(e.message ?: "거래 선택 실패", header, (e as? ProtocolCompiler.ProtocolFailure)?.code) }
            val effective = plan.effectiveSpec(transaction)
            val expected = when (effective.framingMode(direction)) { "fixed" -> effective.framingFor(direction)?.fixedLength; "length" -> ProtocolCodec.totalFromDeclared(effective, ProtocolCodec.parseLength(effective, header), direction); else -> null }
            onSelected(transaction.key, expected)
            val prefixed = java.io.SequenceInputStream(java.io.ByteArrayInputStream(header), input)
            val frame = readPlainFrame(prefixed, effective, direction, captureErrors = true) ?: return null
            return Frame(frame.bytes, chunks + frame.chunks.drop(1), chunks.size > 1 || frame.partial, transaction.key)
        }
        return readPlainFrame(input, spec, direction, captureErrors = spec.schemaVersion == 2)
    }

    private fun readPlainFrame(input: InputStream, spec: ProtocolSpec, direction: Direction, captureErrors: Boolean): Frame? {
        val hl = spec.headerLen()
        if (hl > MAX_FRAME) throw FrameException("헤더 길이가 상한(${MAX_FRAME}B)을 넘습니다.", null)
        when (val mode = spec.framingMode(direction)) {
            "fixed" -> {
                val n = spec.framingFor(direction)?.fixedLength
                if (n == null || n !in maxOf(1, hl)..MAX_FRAME) throw FrameException("고정 길이는 헤더 이상, 1~${MAX_FRAME}B 범위여야 합니다.", null)
                val chunks = ArrayList<Int>()
                val bytes = readExactly(input, n, chunks, allowEmptyEof = true, captureErrors = captureErrors) ?: return null
                return Frame(bytes, chunks, chunks.size > 1)
            }
            "delimiter" -> return readDelimited(input, spec.delimiterBytes(direction), captureErrors)
            "length" -> Unit
            else -> throw FrameException("지원하지 않는 프레이밍: $mode", null)
        }
        if (hl <= 0) throw FrameException("헤더 길이가 0 인 프로토콜은 프레이밍할 수 없습니다.", null)
        val chunks = ArrayList<Int>()
        val head = readExactly(input, hl, chunks, allowEmptyEof = true, captureErrors = captureErrors) ?: return null
        val headPartial = chunks.size > 1
        val declared = try { ProtocolCodec.parseLength(spec, head) } catch (e: ProtocolCodec.ProtocolException) { throw FrameException(e.message ?: "길이 파싱 실패", head) }
        val total = try { ProtocolCodec.totalFromDeclared(spec, declared, direction) } catch (e: ProtocolCodec.ProtocolException) { throw FrameException(e.message ?: "길이 계산 실패", head) }
        if (total < hl || total > MAX_FRAME) throw FrameException("잘못된 전문 길이: 선언 $declared → 전체 ${total}B (헤더 ${hl}B, 상한 ${MAX_FRAME}B)", head)
        val bodyFrom = chunks.size
        val rest = try { readExactly(input, total - hl, chunks, allowEmptyEof = false, captureErrors = captureErrors)!! } catch (e: FrameException) { throw FrameException(e.message ?: "본문 수신 실패", head + (e.raw ?: ByteArray(0)), e.code, total) }
        return Frame(head + rest, chunks, headPartial || chunks.size - bodyFrom > 1)
    }

    private fun readDelimited(input: InputStream, delimiter: ByteArray?, captureErrors: Boolean): Frame? {
        if (delimiter == null || delimiter.size !in 1..64) throw FrameException("구분자는 1~64바이트 HEX 형식이어야 합니다.", null)
        val prefix = IntArray(delimiter.size)
        var matched = 0
        for (i in 1 until delimiter.size) {
            while (matched > 0 && delimiter[i] != delimiter[matched]) matched = prefix[matched - 1]
            if (delimiter[i] == delimiter[matched]) matched++
            prefix[i] = matched
        }
        matched = 0
        val bytes = ByteArrayOutputStream()
        while (bytes.size() < MAX_FRAME) {
            val value = try { input.read() } catch (e: IOException) { if (!captureErrors) throw e; throw FrameException(e.message ?: "구분 전문 수신 실패", bytes.toByteArray(), if (e is java.net.SocketTimeoutException) "FRAME_TIMEOUT" else "FRAME_IO") }
            if (value < 0) {
                if (bytes.size() == 0) return null
                throw FrameException("종료 구분자를 받기 전에 연결이 종료되었습니다(${bytes.size()}B).", bytes.toByteArray(), "FRAME_EOF")
            }
            bytes.write(value)
            val byte = value.toByte()
            while (matched > 0 && byte != delimiter[matched]) matched = prefix[matched - 1]
            if (byte == delimiter[matched]) matched++
            if (matched == delimiter.size) {
                // 종료 위치까지만 소비하므로 다음 전문을 보존한다. 단일 바이트 검색에서는 네트워크 청크를 추론할 수 없다.
                return Frame(bytes.toByteArray(), listOf(bytes.size()), false)
            }
        }
        throw FrameException("종료 구분자 없이 전문 길이 상한(${MAX_FRAME}B)을 넘었습니다.", bytes.toByteArray())
    }

    private fun readExactly(input: InputStream, n: Int, chunks: MutableList<Int>, allowEmptyEof: Boolean, captureErrors: Boolean = false): ByteArray? {
        val buf = ByteArray(n)
        var got = 0
        while (got < n) {
            val r = try { input.read(buf, got, n - got) } catch (e: IOException) {
                if (!captureErrors) throw e
                throw FrameException(e.message ?: "수신 실패 ($got/$n 바이트)", buf.copyOf(got), if (e is java.net.SocketTimeoutException) "FRAME_TIMEOUT" else "FRAME_IO", n)
            }
            if (r < 0) {
                if (got == 0 && allowEmptyEof) return null
                throw FrameException("수신 중 연결 종료 ($got/$n 바이트)", buf.copyOf(got), "FRAME_EOF", n)
            }
            if (r == 0) throw FrameException("스트림이 진행하지 않습니다(0바이트 읽기, $got/$n 바이트)", buf.copyOf(got))
            chunks.add(r)
            got += r
        }
        return buf
    }
}
