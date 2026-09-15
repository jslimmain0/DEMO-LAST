package com.flowlink.protocol

import com.flowlink.protocol.ProtocolSpec.Field
import com.flowlink.protocol.ProtocolSpec.Message
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.SequenceInputStream
import java.util.Collections

class FramerTest {
    private val spec = ProtocolSpec(encoding = "EUC-KR", lengthField = "전문길이", discriminator = "거래코드",
        header = listOf(Field("전문길이", 4, "length"), Field("거래코드", 4, "ascii")),
        messages = listOf(Message("0210", null, listOf(Field("계좌번호", 13, "ascii")))))
    private val msg = ProtocolCodec.encode(spec, "0210", mapOf("계좌번호" to "1122334567890")).bytes // 21B

    /** 지정 크기로 쪼개 주는 스트림 — read 가 청크 경계까지만 돌려준다(소켓 분할 수신 흉내). */
    private fun chunked(bytes: ByteArray, vararg sizes: Int): InputStream {
        val parts = ArrayList<InputStream>(); var i = 0
        for (s in sizes) { parts.add(ByteArrayInputStream(bytes.copyOfRange(i, minOf(i + s, bytes.size)))); i += s }
        if (i < bytes.size) parts.add(ByteArrayInputStream(bytes.copyOfRange(i, bytes.size)))
        return SequenceInputStream(Collections.enumeration(parts))
    }

    @Test
    fun `한 번에 온 전문`() {
        val f = Framer.readFrame(ByteArrayInputStream(msg), spec)!!
        assertThat(f.bytes).isEqualTo(msg)
        assertThat(f.chunks).containsExactly(8, 13)
    }

    @Test
    fun `쪼개져 와도 프레임 완성 + 청크 기록`() {
        val f = Framer.readFrame(chunked(msg, 3, 9, 5), spec)!!
        assertThat(f.bytes).isEqualTo(msg)
        assertThat(f.chunks).containsExactly(3, 5, 4, 5, 4) // 헤더 8: 3+5 / 본문 13: 4+5+4
    }

    @Test
    fun `같은 스트림에서 전문 두 개, 그 다음 깨끗한 EOF 는 null`() {
        val two = msg + msg
        val input = ByteArrayInputStream(two)
        assertThat(Framer.readFrame(input, spec)!!.bytes).isEqualTo(msg)
        assertThat(Framer.readFrame(input, spec)!!.bytes).isEqualTo(msg)
        assertThat(Framer.readFrame(input, spec)).isNull()
    }

    @Test
    fun `헤더 도중 EOF, 본문 도중 EOF 는 예외`() {
        assertThatThrownBy { Framer.readFrame(ByteArrayInputStream(msg.copyOf(5)), spec) }.isInstanceOf(Framer.FrameException::class.java).hasMessageContaining("5/8")
        assertThatThrownBy { Framer.readFrame(ByteArrayInputStream(msg.copyOf(15)), spec) }.isInstanceOf(Framer.FrameException::class.java).hasMessageContaining("7/13")
    }

    @Test
    fun `길이 NaN - 원본 바이트를 담은 예외`() {
        val bad = "0\" 1" + "0210" + "1122334567890"
        assertThatThrownBy { Framer.readFrame(ByteArrayInputStream(bad.toByteArray()), spec) }
            .isInstanceOf(Framer.FrameException::class.java).hasMessageContaining("0\" 1")
            .satisfies({ e -> assertThat((e as Framer.FrameException).raw).isEqualTo("0\" 10210".toByteArray()) })
    }

    @Test
    fun `선언 길이가 헤더보다 작거나 상한 초과면 예외`() {
        val small = ProtocolCodec.withLength(spec, msg, 2)
        assertThatThrownBy { Framer.readFrame(ByteArrayInputStream(small), spec) }.hasMessageContaining("잘못된 전문 길이")
    }

    @Test
    fun `read 가 0바이트를 반환하면 무한루프 대신 예외`() {
        val stuck = object : InputStream() {
            override fun read(): Int = throw UnsupportedOperationException()
            override fun read(b: ByteArray, off: Int, len: Int): Int = 0
        }
        assertThatThrownBy { Framer.readFrame(stuck, spec) }.isInstanceOf(Framer.FrameException::class.java).hasMessageContaining("0바이트")
    }
}
