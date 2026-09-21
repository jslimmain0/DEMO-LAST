package com.flowlink.protocol

import com.flowlink.codec.CodecCtx
import com.flowlink.codec.FieldCodec
import com.flowlink.codec.MessageCodec
import com.flowlink.protocol.ProtocolSpec.Field
import com.flowlink.protocol.ProtocolSpec.Message
import com.flowlink.protocol.ProtocolSpec.PluginRef
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.nio.charset.Charset
import java.util.Base64

class ProtocolCodecTest {
    private val eucKr: Charset = Charset.forName("EUC-KR")
    private fun spec(includesSelf: Boolean = false, format: String = "ascii-decimal", endian: String = "big", lenLen: Int = 4, plugins: List<PluginRef>? = null) = ProtocolSpec(
        encoding = "EUC-KR", lengthField = "전문길이", lengthFormat = format, endian = endian, includesSelf = includesSelf, discriminator = "거래코드",
        header = listOf(Field("전문길이", lenLen, "length"), Field("거래코드", 4, "ascii")),
        messages = listOf(
            Message("0210", "요청", listOf(Field("계좌번호", 13, "ascii"), Field("고객명", 20, "string"), Field("금액", 15, "numeric"))),
            Message("0211", "응답", listOf(Field("응답코드", 4, "ascii"), Field("잔액", 15, "numeric"), Field("최종거래일", 8, "ascii", "none"))),
        ),
        messagePlugins = plugins,
    )
    private val req = mapOf("계좌번호" to "1122334567890", "고객명" to "김철수", "금액" to "0")

    @Test
    fun `encode - 헤더 자동, EUC-KR 바이트 패딩, 길이 ascii-decimal 자기 미포함`() {
        val e = ProtocolCodec.encode(spec(), "0210", req)
        val s = String(e.bytes, eucKr)
        assertThat(e.bytes.size).isEqualTo(56)
        assertThat(s.substring(0, 4)).isEqualTo("0052")            // 56 - 4
        assertThat(s.substring(4, 8)).isEqualTo("0210")            // discriminator 자동
        assertThat(String(e.bytes.copyOfRange(21, 41), eucKr)).isEqualTo("김철수" + " ".repeat(14)) // 6B + 14 공백
        assertThat(String(e.bytes.copyOfRange(41, 56), eucKr)).isEqualTo("000000000000000")
        assertThat(e.fields.map { it.name to it.offset }).containsExactly("전문길이" to 0, "거래코드" to 4, "계좌번호" to 8, "고객명" to 21, "금액" to 41)
        assertThat(e.fields[3].actualBytes).isEqualTo(6)
        assertThat(e.warnings).isEmpty()
    }

    @Test
    fun `includesSelf true 면 길이값 = 전체`() {
        val e = ProtocolCodec.encode(spec(includesSelf = true), "0210", req)
        assertThat(String(e.bytes.copyOfRange(0, 4), eucKr)).isEqualTo("0056")
        assertThat(ProtocolCodec.declaredLength(spec(true), 56)).isEqualTo(56)
        assertThat(ProtocolCodec.declaredLength(spec(false), 56)).isEqualTo(52)
        assertThat(ProtocolCodec.totalFromDeclared(spec(false), 52)).isEqualTo(56)
    }

    @Test
    fun `binary 길이 big-little endian`() {
        val big = ProtocolCodec.encode(spec(format = "binary", lenLen = 2), "0210", req).bytes
        assertThat(big.copyOfRange(0, 2)).containsExactly(0x00, 0x34) // 54-2=52 → 0x0034
        val little = ProtocolCodec.encode(spec(format = "binary", endian = "little", lenLen = 2), "0210", req).bytes
        assertThat(little.copyOfRange(0, 2)).containsExactly(0x34, 0x00)
        assertThat(ProtocolCodec.parseLength(spec(format = "binary", lenLen = 2), big)).isEqualTo(52)
        assertThat(ProtocolCodec.parseLength(spec(format = "binary", endian = "little", lenLen = 2), little)).isEqualTo(52)
    }

    @Test
    fun `decode - 패딩 제거, discriminator 로 표 선택, 길이 검증`() {
        val e = ProtocolCodec.encode(spec(), "0210", req)
        val d = ProtocolCodec.decode(spec(), e.bytes, Direction.SEND)
        assertThat(d.header["전문길이"]).isEqualTo("52")
        assertThat(d.header["거래코드"]).isEqualTo("0210")
        assertThat(d.messageKey).isEqualTo("0210")
        assertThat(d.body).containsExactly(java.util.Map.entry("계좌번호", "1122334567890"), java.util.Map.entry("고객명", "김철수"), java.util.Map.entry("금액", "0"))
        assertThat(d.warnings).isEmpty()
        val resp = ProtocolCodec.encode(spec(), "0211", mapOf("응답코드" to "0000", "잔액" to "1250000", "최종거래일" to "20260915")).bytes
        val rd = ProtocolCodec.decode(spec(), resp, Direction.RECV)
        assertThat(rd.body!!["잔액"]).isEqualTo("1250000")
        assertThat(rd.body!!["최종거래일"]).isEqualTo("20260915")
    }

    @Test
    fun `decode - 미정의 전문은 헤더만 + rawBody, 길이 불일치는 warning`() {
        val bytes = ("0010" + "9999" + "ABCDEFGHIJ").toByteArray(eucKr)
        val d = ProtocolCodec.decode(spec(), bytes)
        assertThat(d.header["거래코드"]).isEqualTo("9999")
        assertThat(d.messageKey).isNull()
        assertThat(d.body).isNull()
        assertThat(String(d.rawBody, eucKr)).isEqualTo("ABCDEFGHIJ")
        val bad = ("0300" + "9999" + "ABCDEFGHIJ").toByteArray(eucKr)
        assertThat(ProtocolCodec.decode(spec(), bad).warnings).anyMatch { it.contains("선언 300") && it.contains("실제 18") }
    }

    @Test
    fun `parseLength - NaN 이면 원본 바이트를 담은 예외`() {
        val bad = ("0\" 1" + "0210").toByteArray(eucKr)
        assertThatThrownBy { ProtocolCodec.parseLength(spec(), bad) }
            .isInstanceOf(ProtocolCodec.ProtocolException::class.java).hasMessageContaining("0\" 1")
    }

    @Test
    fun `전송 전 검증 - 초과, ascii 에 한글, numeric 에 문자, hex 오류`() {
        assertThatThrownBy { ProtocolCodec.encode(spec(), "0210", req + ("고객명" to "가나다라마바사아자차카")) }
            .isInstanceOf(ProtocolCodec.ProtocolException::class.java).hasMessageContaining("20바이트").hasMessageContaining("22바이트")
        assertThatThrownBy { ProtocolCodec.encode(spec(), "0210", req + ("계좌번호" to "계좌")) }.hasMessageContaining("ascii")
        assertThatThrownBy { ProtocolCodec.encode(spec(), "0210", req + ("금액" to "12a")) }.hasMessageContaining("숫자")
        val bin = spec().copy(messages = listOf(Message("0210", null, listOf(Field("raw", 2, "binary")))))
        assertThatThrownBy { ProtocolCodec.encode(bin, "0210", mapOf("raw" to "zz")) }.hasMessageContaining("hex")
        val ok = ProtocolCodec.encode(bin, "0210", mapOf("raw" to "0A FF")).bytes
        assertThat(ok.copyOfRange(8, 10)).containsExactly(0x0A, 0xFF.toByte())
        assertThat(ProtocolCodec.decode(bin, ok, Direction.SEND).body!!["raw"]).isEqualTo("0A FF")
    }

    @Test
    fun `lenient - 문자 경계 안전 절단 + warning`() {
        val e = ProtocolCodec.encode(spec(), "0210", req + ("고객명" to "가나다라마바사아자차카"), lenient = true)
        assertThat(String(e.bytes.copyOfRange(21, 41), eucKr)).isEqualTo("가나다라마바사아자차") // 10자=20B, 반쪽 없음
        assertThat(e.warnings).anyMatch { it.contains("고객명") && it.contains("22B") && it.contains("20B") }
        assertThat(e.fields[3].warn).isNotNull()
    }

    @Test
    fun `길이 필드 자릿수 초과는 에러`() {
        val s = spec().copy(header = listOf(Field("전문길이", 1, "length"), Field("거래코드", 4, "ascii")))
        assertThatThrownBy { ProtocolCodec.encode(s, "0210", req) }.hasMessageContaining("자리")
    }

    @Test
    fun `withLength 로 길이 필드만 바꿔 쓴다`() {
        val e = ProtocolCodec.encode(spec(), "0210", req).bytes
        val c = ProtocolCodec.withLength(spec(), e, 59)
        assertThat(String(c.copyOfRange(0, 4), eucKr)).isEqualTo("0059")
        assertThat(c.size).isEqualTo(e.size)
    }

    private val b64 = object : FieldCodec { override fun id() = "b64"; override fun encode(v: String, ctx: CodecCtx) = Base64.getEncoder().encodeToString(v.toByteArray()); override fun decode(v: String, ctx: CodecCtx) = String(Base64.getDecoder().decode(v)) }
    private val xor = object : MessageCodec { override fun id() = "xor"; override fun encode(b: ByteArray, ctx: CodecCtx) = ByteArray(b.size) { (b[it].toInt() xor 0x5A).toByte() }; override fun decode(b: ByteArray, ctx: CodecCtx) = encode(b, ctx) }
    private val lookup = ProtocolCodec.PluginLookup { id -> when (id) { "b64" -> b64; "xor" -> xor; else -> null } }

    @Test
    fun `플러그인 - 필드는 문자셋 전, 메시지는 본문만·헤더 평문, decode 는 역순`() {
        val s = spec(plugins = listOf(PluginRef("xor"))).let { it.copy(messages = listOf(Message("0210", null, listOf(Field("계좌번호", 24, "ascii", plugin = PluginRef("b64")), Field("금액", 15, "numeric"))))) }
        val e = ProtocolCodec.encode(s, "0210", mapOf("계좌번호" to "1122334567890", "금액" to "0"), plugins = lookup)
        assertThat(String(e.bytes.copyOfRange(0, 8), eucKr)).isEqualTo("0043" + "0210") // 헤더 평문, 47-4
        assertThat(String(e.bytes.copyOfRange(8, 47), eucKr)).isNotEqualTo("MTEyMjMzNDU2Nzg5MA==" + "    " + "000000000000000") // 본문은 xor 됨
        val d = ProtocolCodec.decode(s, e.bytes, Direction.SEND, lookup)
        assertThat(d.body!!["계좌번호"]).isEqualTo("1122334567890")
        assertThat(d.body!!["금액"]).isEqualTo("0")
        assertThatThrownBy { ProtocolCodec.encode(s, "0210", mapOf("계좌번호" to "1", "금액" to "0")) }.hasMessageContaining("b64")
    }

    @Test
    fun `trimPad 규칙`() {
        assertThat(ProtocolCodec.trimPad("abc   ", "right/space")).isEqualTo("abc")
        assertThat(ProtocolCodec.trimPad("   57", "left/space")).isEqualTo("57")
        assertThat(ProtocolCodec.trimPad("000123", "left/zero")).isEqualTo("123")
        assertThat(ProtocolCodec.trimPad("0000", "left/zero")).isEqualTo("0")
        assertThat(ProtocolCodec.trimPad("ab  ", "none")).isEqualTo("ab  ")
    }

    @Test
    fun `decodeEscaped - 깨진 바이트는 원본 노출`() {
        val broken = byteArrayOf(0x41, 0xB1.toByte(), 0x42)
        assertThat(com.flowlink.common.tcp.TcpBytes.decodeEscaped(broken, eucKr)).isEqualTo("A\\xB1B")
        assertThat(com.flowlink.common.tcp.TcpBytes.decodeEscaped("김".toByteArray(eucKr), eucKr)).isEqualTo("김")
    }

    @Test
    fun `패딩 4종 encode`() {
        val padSpec = ProtocolSpec(
            encoding = "EUC-KR", lengthField = "길이", lengthFormat = "ascii-decimal", includesSelf = false,
            header = listOf(Field("길이", 4, "length")),
            messages = listOf(Message("request", null, listOf(
                Field("a", 6, "ascii", "left/zero"),
                Field("b", 6, "ascii", "right/space"),
                Field("c", 6, "ascii", "left/space"),
                Field("d", 6, "ascii", "none"),
            ))),
        )
        val e = ProtocolCodec.encode(padSpec, "request", mapOf("a" to "ab", "b" to "ab", "c" to "ab", "d" to "ab"))
        assertThat(String(e.bytes.copyOfRange(4, 10), eucKr)).isEqualTo("0000ab")
        assertThat(String(e.bytes.copyOfRange(10, 16), eucKr)).isEqualTo("ab    ")
        assertThat(String(e.bytes.copyOfRange(16, 22), eucKr)).isEqualTo("    ab")
        assertThat(String(e.bytes.copyOfRange(22, 28), eucKr)).isEqualTo("ab    ")
        val d = ProtocolCodec.decode(padSpec, e.bytes, Direction.SEND)
        assertThat(d.body!!["a"]).isEqualTo("ab")
        assertThat(d.body!!["b"]).isEqualTo("ab")
        assertThat(d.body!!["c"]).isEqualTo("ab")
        assertThat(d.body!!["d"]).isEqualTo("ab    ")
    }

    @Test
    fun `numeric 비ASCII 숫자 거부`() {
        assertThatThrownBy { ProtocolCodec.encode(spec(), "0210", req + ("금액" to "１２")) }
            .isInstanceOf(ProtocolCodec.ProtocolException::class.java).hasMessageContaining("숫자")
    }

    @Test
    fun `binary 길이 범위 초과`() {
        val big = ProtocolSpec(
            encoding = "EUC-KR", lengthField = "len", lengthFormat = "binary", endian = "big", includesSelf = false,
            header = listOf(Field("len", 1, "length")),
            messages = listOf(Message("request", null, listOf(Field("body", 300, "ascii")))),
        )
        assertThatThrownBy { ProtocolCodec.encode(big, "request", emptyMap()) }
            .isInstanceOf(ProtocolCodec.ProtocolException::class.java).hasMessageContaining("범위")
    }

    @Test
    fun `인코딩 불가 문자 거부`() {
        assertThatThrownBy { ProtocolCodec.encode(spec(), "0210", req + ("고객명" to "😀")) }
            .isInstanceOf(ProtocolCodec.ProtocolException::class.java).hasMessageContaining("인코딩할 수 없는")

        val utf8 = ProtocolSpec(
            encoding = "UTF-8", lengthField = "len", lengthFormat = "ascii-decimal", includesSelf = false,
            header = listOf(Field("len", 4, "length")),
            messages = listOf(Message("request", null, listOf(Field("emoji", 5, "string")))),
        )
        val emoji = "😀"
        val e = ProtocolCodec.encode(utf8, "request", mapOf("emoji" to emoji + emoji + emoji), lenient = true)
        val off = utf8.headerLen()
        assertThat(e.bytes.copyOfRange(off, off + 5)).isEqualTo(emoji.toByteArray(Charsets.UTF_8) + byteArrayOf(0x20))
    }

    @Test
    fun `총합 상한`() {
        val big = ProtocolSpec(
            lengthField = "len", header = listOf(Field("len", 4, "length")),
            messages = listOf(Message("request", null, listOf(Field("body", 1 shl 20, "string")))),
        )
        assertThat(big.validate()).anyMatch { it.contains("상한") }
    }

    @Test
    fun `코덱 파라미터의 토큰은 호출자의 resolve 로 풀린다(없으면 그대로)`() {
        val cfg = object : FieldCodec { override fun id() = "cfg"; override fun encode(v: String, ctx: CodecCtx) = (ctx.config["k"] ?: "?") + v; override fun decode(v: String, ctx: CodecCtx) = v.removePrefix(ctx.config["k"] ?: "?") }
        val lk = ProtocolCodec.PluginLookup { if (it == "cfg") cfg else null }
        val s = spec().copy(messages = listOf(Message("0210", null, listOf(Field("계좌번호", 20, "ascii", plugin = PluginRef("cfg", mapOf("k" to "{{ pre@env }}")))))))
        val resolve: (String) -> String = { it.replace("{{ pre@env }}", "X-") }
        val e = ProtocolCodec.encode(s, "0210", mapOf("계좌번호" to "123"), plugins = lk, resolve = resolve)
        assertThat(e.fields.first { it.name == "계좌번호" }.value.trim()).isEqualTo("X-123")
        assertThat(ProtocolCodec.decode(s, e.bytes, Direction.RECV, lk, resolve = resolve).body!!["계좌번호"]).isEqualTo("123")
        val raw = ProtocolCodec.encode(s, "0210", mapOf("계좌번호" to "123"), plugins = lk)
        assertThat(raw.fields.first { it.name == "계좌번호" }.value).startsWith("{{ pre@env }}123")
    }

    // ---------- 길이 보정(lengthAdjustment) ----------

    @Test
    fun `lengthAdjustment - 인코딩·디코딩 대칭(0·양수·음수), 본문 길이만 싣는 전문`() {
        val base = spec()
        val plain = ProtocolCodec.encode(base, "0210", req)
        val total = plain.bytes.size
        for (adj in listOf(0, 7, -7)) {
            val s = base.copy(lengthAdjustment = adj)
            val e = ProtocolCodec.encode(s, "0210", req)
            assertThat(e.bytes.size).isEqualTo(total) // 보정은 길이 '값'만 바꾼다 — 실제 크기는 그대로
            assertThat(ProtocolCodec.parseLength(s, e.bytes)).isEqualTo(total - 4 + adj) // includesSelf=false → 전체-길이필드(4)
            assertThat(ProtocolCodec.totalFromDeclared(s, ProtocolCodec.parseLength(s, e.bytes))).isEqualTo(total)
            assertThat(ProtocolCodec.decode(s, e.bytes, Direction.SEND).body!!["계좌번호"]).isEqualTo("1122334567890")
        }
        // 본문 길이만 싣는 전문 = -(헤더길이 - 길이필드len). 엔진에 '본문 모드'를 두지 않고 보정으로 표현한다.
        val bodyOnly = base.copy(lengthAdjustment = -(base.headerLen() - 4))
        val e = ProtocolCodec.encode(bodyOnly, "0210", req)
        assertThat(ProtocolCodec.parseLength(bodyOnly, e.bytes)).isEqualTo(total - bodyOnly.headerLen())
        assertThat(Framer.readFrame(e.bytes.inputStream(), bodyOnly)!!.bytes).isEqualTo(e.bytes) // 수신 프레이밍도 대칭
    }

    @Test
    fun `lengthAdjustment - 음수 길이·상한 밖 보정은 거부`() {
        val tooSmall = spec().copy(lengthAdjustment = -100_000)
        assertThatThrownBy { ProtocolCodec.encode(tooSmall, "0210", req) }
            .isInstanceOf(ProtocolCodec.ProtocolException::class.java).hasMessageContaining("음수")
        assertThat(spec().copy(lengthAdjustment = (1 shl 20) + 1).validate()).anyMatch { it.contains("길이 보정값") }
        // 수신: 보정을 되돌리면 헤더보다 짧아지는 프레임 → 프레이밍 거부
        val s = spec().copy(lengthAdjustment = 1000)
        val frame = ProtocolCodec.encode(spec(), "0210", req).bytes
        assertThatThrownBy { Framer.readFrame(frame.inputStream(), s) }.isInstanceOf(Framer.FrameException::class.java)
    }

    // ---------- 전체 프레임 코덱(wireCodec) ----------

    /** 전 바이트 XOR 를 헤더 뒤 2바이트에 쓰는 대신, 여기선 검증만 쉽게 — 프레임 끝에 1바이트 BCC 를 '덮어쓴다'(길이 불변). */
    private class Bcc(val mark: Byte = 0x7F) : com.flowlink.codec.WireCodec {
        var lastCtx: CodecCtx? = null
        var calls = 0
        override fun id() = "bcc"
        override fun encode(frame: ByteArray, ctx: CodecCtx): ByteArray {
            lastCtx = ctx; calls++
            val out = frame.copyOf(); out[out.size - 1] = frame.dropLast(1).fold(0) { a, b -> a xor (b.toInt() and 0xff) }.toByte(); return out
        }
        override fun decode(frame: ByteArray, ctx: CodecCtx): ByteArray {
            lastCtx = ctx; calls++
            val out = frame.copyOf(); out[out.size - 1] = mark; return out
        }
    }
    private class Grow : com.flowlink.codec.WireCodec {
        override fun id() = "grow"
        override fun encode(frame: ByteArray, ctx: CodecCtx) = frame + byteArrayOf(0x21)
        override fun decode(frame: ByteArray, ctx: CodecCtx) = frame.copyOf(frame.size - 1)
    }
    private class Boom : com.flowlink.codec.WireCodec {
        override fun id() = "boom"
        override fun encode(frame: ByteArray, ctx: CodecCtx): ByteArray = throw IllegalStateException("서명 실패")
        override fun decode(frame: ByteArray, ctx: CodecCtx): ByteArray = throw IllegalStateException("검증 실패")
    }

    @Test
    fun `wireCodec - 전체 프레임을 보고, 헤더 길이·전문 키가 ctx 에 온다`() {
        val bcc = Bcc()
        val lk = ProtocolCodec.PluginLookup { if (it == "bcc") bcc else null }
        val s = spec().copy(wirePlugins = listOf(PluginRef("bcc")))
        val e = ProtocolCodec.encode(s, "0210", req, plugins = lk)
        assertThat(bcc.calls).isEqualTo(1)
        assertThat(bcc.lastCtx!!.headerLength).isEqualTo(s.headerLen())
        assertThat(bcc.lastCtx!!.messageKey).isEqualTo("0210")
        assertThat(bcc.lastCtx!!.direction).isEqualTo("send")
        // 마지막 바이트가 앞 전체의 XOR 로 바뀌었다 = 헤더까지 포함해 봤다는 뜻
        val expected = e.bytes.dropLast(1).fold(0) { a, b -> a xor (b.toInt() and 0xff) }.toByte()
        assertThat(e.bytes.last()).isEqualTo(expected)
        // 수신: 헤더 분리 전에 decode 가 돈다(끝 1바이트를 마크로 되돌린 뒤 파싱)
        val d = ProtocolCodec.decode(s, e.bytes, Direction.SEND, lk)
        assertThat(bcc.calls).isEqualTo(2)
        assertThat(d.header["거래코드"]).isEqualTo("0210")
    }

    @Test
    fun `wireCodec - 기본은 같은 길이 강제, recalc 면 길이 필드를 다시 쓴다`() {
        val lk = ProtocolCodec.PluginLookup { if (it == "grow") Grow() else null }
        val strict = spec().copy(wirePlugins = listOf(PluginRef("grow")))
        assertThatThrownBy { ProtocolCodec.encode(strict, "0210", req, plugins = lk) }
            .isInstanceOf(ProtocolCodec.ProtocolException::class.java).hasMessageContaining("길이를 바꿨습니다")
        val recalc = strict.copy(wireLengthPolicy = "recalc")
        val e = ProtocolCodec.encode(recalc, "0210", req, plugins = lk)
        assertThat(ProtocolCodec.parseLength(recalc, e.bytes)).isEqualTo(e.bytes.size - 4) // 커진 크기로 다시 계산
        assertThat(spec().copy(wireLengthPolicy = "nope").validate()).anyMatch { it.contains("wireLengthPolicy") }
    }

    @Test
    fun `wireCodec - 플러그인 오류·미등록은 전문 오류로 올라온다`() {
        val lk = ProtocolCodec.PluginLookup { if (it == "boom") Boom() else null }
        val s = spec().copy(wirePlugins = listOf(PluginRef("boom")))
        assertThatThrownBy { ProtocolCodec.encode(s, "0210", req, plugins = lk) }.hasMessageContaining("서명 실패")
        val missing = spec().copy(wirePlugins = listOf(PluginRef("nope")))
        assertThatThrownBy { ProtocolCodec.encode(missing, "0210", req) }
            .isInstanceOf(ProtocolCodec.ProtocolException::class.java).hasMessageContaining("WireCodec")
    }
}
