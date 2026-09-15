package com.flowlink.protocol

import java.io.IOException
import java.io.InputStream

/**
 * 스트림에서 전문 1개를 잘라낸다 — 헤더 길이만큼 확보 → 길이 파싱(NaN 이면 원본 바이트 포함 예외) → includes-self 역산 → 나머지 대기.
 * read 한 번 ≠ 전문 하나이므로 청크 크기를 기록해 "부분 수신"을 로그에 보일 수 있게 한다.
 */
object Framer {
    const val MAX_FRAME = 1 shl 20

    class Frame(val bytes: ByteArray, val chunks: List<Int>)
    class FrameException(message: String, val raw: ByteArray?) : IOException(message)

    /** null = 바이트 0 에서 깨끗한 EOF(상대가 닫음). */
    fun readFrame(input: InputStream, spec: ProtocolSpec): Frame? {
        val hl = spec.headerLen()
        if (hl <= 0) throw FrameException("헤더 길이가 0 인 프로토콜은 프레이밍할 수 없습니다.", null)
        val chunks = ArrayList<Int>()
        val head = readExactly(input, hl, chunks, allowEmptyEof = true) ?: return null
        val declared = try { ProtocolCodec.parseLength(spec, head) } catch (e: ProtocolCodec.ProtocolException) { throw FrameException(e.message ?: "길이 파싱 실패", head) }
        val total = ProtocolCodec.totalFromDeclared(spec, declared)
        if (total < hl || total > MAX_FRAME) throw FrameException("잘못된 전문 길이: 선언 $declared → 전체 ${total}B (헤더 ${hl}B, 상한 ${MAX_FRAME}B)", head)
        val rest = readExactly(input, total - hl, chunks, allowEmptyEof = false)!!
        return Frame(head + rest, chunks)
    }

    private fun readExactly(input: InputStream, n: Int, chunks: MutableList<Int>, allowEmptyEof: Boolean): ByteArray? {
        val buf = ByteArray(n)
        var got = 0
        while (got < n) {
            val r = input.read(buf, got, n - got)
            if (r < 0) {
                if (got == 0 && allowEmptyEof) return null
                throw FrameException("수신 중 연결 종료 ($got/$n 바이트)", buf.copyOf(got))
            }
            if (r == 0) throw FrameException("스트림이 진행하지 않습니다(0바이트 읽기, $got/$n 바이트)", buf.copyOf(got))
            chunks.add(r)
            got += r
        }
        return buf
    }
}
