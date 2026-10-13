package com.flowlink.protocol

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.protocol.ProtocolSpec.Field
import com.flowlink.protocol.ProtocolSpec.Framing
import com.flowlink.protocol.ProtocolSpec.Message
import com.flowlink.protocol.ProtocolSpec.Transport
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

class ProtocolFramingTest {
    private fun lengthSpec() = ProtocolSpec(encoding = "UTF-8", lengthField = "len", includesSelf = true,
        header = listOf(Field("prefix", 2, "ascii"), Field("len", 4, "length"), Field("code", 2, "ascii")),
        messages = listOf(Message("request", fields = listOf(Field("value", 3, "ascii"))), Message("response", fields = listOf(Field("value", 3, "ascii")))))

    private fun fixedSpec() = ProtocolSpec(encoding = "UTF-8", framing = Framing("fixed", fixedLength = 5),
        responseFraming = Framing("fixed", fixedLength = 3), messages = listOf(
            Message("request", fields = listOf(Field("value", 5, "ascii"))), Message("response", fields = listOf(Field("value", 3, "ascii")))))

    private fun delimitedSpec() = ProtocolSpec(encoding = "UTF-8", framing = Framing("delimiter", delimiterHex = "41 41 41 42"),
        messages = listOf(Message("request", fields = listOf(Field("value", 4, "ascii"))), Message("response", fields = listOf(Field("value", 4, "ascii")))))

    private fun chunked(bytes: ByteArray, size: Int) = object : InputStream() {
        var offset = 0
        override fun read(): Int = if (offset == bytes.size) -1 else bytes[offset++].toInt() and 0xff
        override fun read(target: ByteArray, from: Int, len: Int): Int {
            if (offset == bytes.size) return -1
            val n = minOf(size, len, bytes.size - offset)
            bytes.copyInto(target, from, offset, offset + n); offset += n
            return n
        }
    }

    @Test fun `헤더 중간 길이 필드와 본문 길이 보정 및 응답 보정이 독립적이다`() {
        val spec = lengthSpec().copy(framing = Framing(lengthAdjustment = 8), responseFraming = Framing(lengthAdjustment = 2))
        assertThat(spec.validate()).isEmpty()
        assertThat(spec.lengthFieldOffset()).isEqualTo(2)
        val request = ProtocolCodec.encode(spec, "request", mapOf("prefix" to "ST", "code" to "Q1", "value" to "abc")).bytes
        val response = ProtocolCodec.encode(spec, "response", mapOf("prefix" to "ST", "code" to "R1", "value" to "xyz"), frameDirection = Direction.RECV).bytes
        assertThat(String(request)).isEqualTo("ST0003Q1abc")
        assertThat(String(response)).isEqualTo("ST0009R1xyz")
        assertThat(Framer.readFrame(ByteArrayInputStream(request), spec, Direction.SEND)!!.bytes).isEqualTo(request)
        assertThat(Framer.readFrame(ByteArrayInputStream(response), spec)!!.bytes).isEqualTo(response)
        assertThat(ProtocolCodec.decode(spec, request, Direction.SEND).warnings).isEmpty()
        assertThat(ProtocolCodec.decode(spec, response).warnings).isEmpty()
    }

    @Test fun `ASCII hex 길이와 binary 8바이트 양쪽 endian을 왕복한다`() {
        val hex = lengthSpec().copy(lengthFormat = "ascii-hex")
        val encoded = ProtocolCodec.encode(hex, "request", mapOf("value" to "abc")).bytes
        assertThat(String(encoded.copyOfRange(2, 6))).isEqualTo("000B")
        assertThat(Framer.readFrame(ByteArrayInputStream(encoded), hex)!!.bytes).isEqualTo(encoded)
        for (endian in listOf("big", "little")) {
            val spec = lengthSpec().copy(lengthFormat = "binary", endian = endian, header = listOf(Field("len", 8, "length")))
            val bytes = ProtocolCodec.encode(spec, "request", mapOf("value" to "abc")).bytes
            assertThat(ProtocolCodec.parseLength(spec, bytes)).isEqualTo(11)
            assertThat(bytes.copyOfRange(0, 8)).isEqualTo(if (endian == "big") byteArrayOf(0, 0, 0, 0, 0, 0, 0, 11) else byteArrayOf(11, 0, 0, 0, 0, 0, 0, 0))
            assertThat(Framer.readFrame(ByteArrayInputStream(bytes), spec)!!.bytes).isEqualTo(bytes)
            assertThat(ProtocolCodec.decode(spec, bytes, Direction.SEND).body!!["value"]).isEqualTo("abc")
        }
    }

    @Test fun `길이 계산 overflow와 unsigned 8바이트 과대 값은 거부한다`() {
        val spec = lengthSpec().copy(framing = Framing(lengthAdjustment = 1))
        assertThatThrownBy { ProtocolCodec.totalFromDeclared(spec, Int.MAX_VALUE) }.hasMessageContaining("범위")
        assertThatThrownBy { ProtocolCodec.declaredLength(spec.copy(framing = Framing(lengthAdjustment = 12)), 11) }.hasMessageContaining("범위")
        val binary = lengthSpec().copy(lengthFormat = "binary", header = listOf(Field("len", 8, "length")))
        assertThatThrownBy { ProtocolCodec.parseLength(binary, ByteArray(8) { 0xff.toByte() }) }.hasMessageContaining("너무 큽니다")
        assertThatThrownBy { Framer.readFrame(ByteArrayInputStream(ByteArray(8) { 0xff.toByte() }), binary) }.isInstanceOf(Framer.FrameException::class.java)
        val large = lengthSpec().copy(header = listOf(Field("len", 8, "length")))
        assertThatThrownBy { Framer.readFrame(ByteArrayInputStream("01048577".toByteArray()), large) }.hasMessageContaining("상한")
    }

    @Test fun `길이 필드 없는 요청과 응답 고정 길이 조립과 해석`() {
        val spec = fixedSpec()
        assertThat(spec.validate()).isEmpty()
        val request = ProtocolCodec.encode(spec, "request", mapOf("value" to "hello")).bytes
        val response = ProtocolCodec.encode(spec, "response", mapOf("value" to "yes"), frameDirection = Direction.RECV).bytes
        assertThat(String(request)).isEqualTo("hello")
        assertThat(String(response)).isEqualTo("yes")
        assertThat(ProtocolCodec.decode(spec, request, Direction.SEND).body!!["value"]).isEqualTo("hello")
        assertThat(ProtocolCodec.decode(spec, response).body!!["value"]).isEqualTo("yes")
        assertThatThrownBy { ProtocolCodec.encode(spec, "response", mapOf("value" to "yes")) }.hasMessageContaining("고정 전문 길이 불일치")
    }

    @Test fun `고정 길이는 분할 수신과 이어 온 여러 전문을 보존한다`() {
        val spec = fixedSpec()
        val input = chunked("helloworld".toByteArray(), 2)
        val first = Framer.readFrame(input, spec, Direction.SEND)!!
        assertThat(String(first.bytes)).isEqualTo("hello")
        assertThat(first.chunks).containsExactly(2, 2, 1)
        assertThat(first.partial).isTrue()
        assertThat(String(Framer.readFrame(input, spec, Direction.SEND)!!.bytes)).isEqualTo("world")
        assertThat(Framer.readFrame(input, spec, Direction.SEND)).isNull()
        assertThatThrownBy { Framer.readFrame(ByteArrayInputStream("hi".toByteArray()), spec, Direction.SEND) }
            .isInstanceOf(Framer.FrameException::class.java).hasMessageContaining("2/5")
            .satisfies({ e -> assertThat((e as Framer.FrameException).raw).isEqualTo("hi".toByteArray()) })
    }

    @Test fun `구분자는 wire에 포함되고 반복 접두사와 다음 전문을 보존한다`() {
        val spec = delimitedSpec()
        assertThat(spec.validate()).isEmpty()
        val bytes = ProtocolCodec.encode(spec, "request", mapOf("value" to "XXAA")).bytes
        assertThat(String(bytes)).isEqualTo("XXAAAAAB")
        val input = chunked(bytes + bytes, 1)
        assertThat(Framer.readFrame(input, spec, Direction.SEND)!!.bytes).isEqualTo(bytes)
        assertThat(Framer.readFrame(input, spec, Direction.SEND)!!.bytes).isEqualTo(bytes)
        assertThat(Framer.readFrame(input, spec, Direction.SEND)).isNull()
        val decoded = ProtocolCodec.decode(spec, bytes, Direction.SEND)
        assertThat(decoded.body!!["value"]).isEqualTo("XXAA")
        assertThat(decoded.rawBody).isEqualTo("XXAA".toByteArray())
        assertThat(decoded.warnings).isEmpty()
        assertThatThrownBy { ProtocolCodec.encode(spec, "request", mapOf("value" to "AAAB")) }.hasMessageContaining("종료 구분자")
        val bordered = spec.copy(framing = Framing("delimiter", delimiterHex = "41 42 41"))
        assertThatThrownBy { ProtocolCodec.encode(bordered, "request", mapOf("value" to "XXAB")) }.hasMessageContaining("종료 구분자")
        assertThatThrownBy { ProtocolCodec.decode(spec, "XXAA".toByteArray()) }.hasMessageContaining("구분자로 끝나지")
    }

    @Test fun `구분자 도착 전 EOF와 전문 상한을 원본으로 남긴다`() {
        val spec = delimitedSpec()
        assertThatThrownBy { Framer.readFrame(ByteArrayInputStream("XXAAA".toByteArray()), spec) }
            .isInstanceOf(Framer.FrameException::class.java).hasMessageContaining("연결이 종료")
            .satisfies({ e -> assertThat((e as Framer.FrameException).raw).isEqualTo("XXAAA".toByteArray()) })
        assertThatThrownBy { Framer.readFrame(ByteArrayInputStream(ByteArray(Framer.MAX_FRAME) { 'X'.code.toByte() }), spec) }.hasMessageContaining("상한")
    }

    @Test fun `잘못된 framing transport와 과대 헤더는 입력을 읽기 전에 거부한다`() {
        assertThat(fixedSpec().copy(framing = Framing("fixed", fixedLength = 0)).validate()).anyMatch { it.contains("고정 길이") }
        assertThat(delimitedSpec().copy(framing = Framing("delimiter", delimiterHex = "zz")).validate()).anyMatch { it.contains("HEX") }
        assertThat(lengthSpec().copy(lengthFormat = "other", endian = "other").validate()).hasSize(2)
        assertThat(lengthSpec().copy(transport = Transport("other", "zz", "AA".repeat(1025))).validate()).hasSize(3)
        assertThat(lengthSpec().copy(transport = Transport("execution", "", " ")).validate()).isEmpty()
        val huge = lengthSpec().copy(header = listOf(Field("len", Int.MAX_VALUE, "length"), Field("extra", Int.MAX_VALUE, "ascii")))
        assertThat(huge.validate()).anyMatch { it.contains("상한") }
        assertThatThrownBy { Framer.readFrame(ByteArrayInputStream(ByteArray(0)), huge) }.hasMessageContaining("헤더 길이")
        assertThatThrownBy { ProtocolCodec.encode(huge, "request", emptyMap()) }.hasMessageContaining("상한")
    }

    @Test fun `새 프레이밍과 전송 옵션은 JSON 왕복한다`() {
        val spec = fixedSpec().copy(transport = Transport("execution", "06", "06"))
        val mapper = jacksonObjectMapper()
        assertThat(mapper.readValue(mapper.writeValueAsBytes(spec), ProtocolSpec::class.java)).isEqualTo(spec)
    }
}
