package com.flowlink.mock

import com.flowlink.mock.MockSpec.MockTcp
import com.flowlink.mock.MockSpec.MockTcpCond
import com.flowlink.mock.MockSpec.MockTcpFault
import com.flowlink.mock.MockSpec.MockTcpRule
import com.flowlink.mock.MockSpec.MockTcpThen
import com.flowlink.protocol.Direction
import com.flowlink.protocol.Framer
import com.flowlink.protocol.ProtocolCodec
import com.flowlink.protocol.ProtocolSpec
import com.flowlink.protocol.ProtocolSpec.Field
import com.flowlink.protocol.ProtocolSpec.Message
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream

class TcpMockSessionTest {
    private val spec = ProtocolSpec(encoding = "EUC-KR", lengthField = "전문길이", discriminator = "거래코드",
        header = listOf(Field("전문길이", 4, "length"), Field("거래코드", 4, "ascii")),
        messages = listOf(
            Message("0210", null, listOf(Field("계좌번호", 13, "ascii"), Field("고객명", 20, "string"))),
            Message("0211", null, listOf(Field("응답코드", 4, "ascii"), Field("잔액", 15, "numeric"), Field("고객명", 6, "string"))),
            Message("9001", null, listOf(Field("응답코드", 4, "ascii"))),
        ))
    private val req = ProtocolCodec.encode(spec, "0210", mapOf("계좌번호" to "1122334567890", "고객명" to "김철수")).bytes
    private fun cond(f: String, v: String) = MockTcpCond(f, "eq", v)
    private fun mock(vararg kv: Pair<String, String>) = MockTcpThen("mock", mapOf(*kv))
    private val logs = ArrayList<MockRuntimeStore.TcpLogEntry>()
    private val slept = ArrayList<Long>()

    private fun session(rules: List<MockTcpRule>, upstream: (() -> TcpMockSession.Upstream?)? = null) =
        TcpMockSession(spec, MockTcp(9600, "p", "h:1", 1000, rules), ProtocolCodec.NO_PLUGINS, mapOf("apiKey" to "SECRET1"), { 1001L }, { logs.add(it) }, upstream ?: { null }, sleeper = { slept.add(it) })

    private fun run(s: TcpMockSession, bytes: ByteArray = req): Pair<ByteArray, Boolean> {
        val out = ByteArrayOutputStream(); var reset = false
        s.serve(ByteArrayInputStream(bytes), out) { reset = true }
        return out.toByteArray() to reset
    }

    @Test
    fun `첫 매칭 규칙 - 헤더 에코 + then 필드 + 템플릿, 초과는 절단 경고`() {
        val rules = listOf(
            MockTcpRule("r1", listOf(cond("거래코드", "0210")), mock("거래코드" to "0211", "응답코드" to "0000", "잔액" to "{{seq}}", "고객명" to "{{req.고객명}}님")),
            MockTcpRule("fb", null, mock("거래코드" to "9001", "응답코드" to "9999")),
        )
        val (resp, _) = run(session(rules))
        val d = ProtocolCodec.decode(spec, resp, Direction.RECV)
        assertThat(d.messageKey).isEqualTo("0211")
        assertThat(d.body!!["응답코드"]).isEqualTo("0000")
        assertThat(d.body!!["잔액"]).isEqualTo("1001")
        assertThat(d.body!!["고객명"]).isEqualTo("김철수") // "김철수님"(8B) → 6B 절단
        assertThat(logs.map { it.dir to it.source }).containsExactly("in" to "mock", "out" to "mock")
        assertThat(logs[0].fields["계좌번호"]).isEqualTo("1122334567890")
        assertThat(logs[0].ruleId).isEqualTo("r1")
        assertThat(logs[1].note).contains("고객명").contains("잘림")
        assertThat(logs[1].level).isEqualTo("warn")
    }

    @Test
    fun `fallback 규칙과 매칭 없음`() {
        val other = ProtocolCodec.encode(spec, "9001", mapOf("응답코드" to "x")).bytes
        val (resp, _) = run(session(listOf(MockTcpRule("fb", null, mock("거래코드" to "9001", "응답코드" to "9999")))), other)
        assertThat(ProtocolCodec.decode(spec, resp, Direction.RECV).body!!["응답코드"]).isEqualTo("9999")
        logs.clear()
        val (none, _) = run(session(listOf(MockTcpRule("r1", listOf(cond("거래코드", "0210")), mock("거래코드" to "9001")))), other)
        assertThat(none).isEmpty()
        assertThat(logs.single().source).isEqualTo("none"); assertThat(logs.single().level).isEqualTo("warn")
    }

    @Test
    fun `장애 주입 - delay, split, corruptLength, drop, reset`() {
        fun rule(f: MockTcpFault) = listOf(MockTcpRule("r", null, mock("거래코드" to "9001", "응답코드" to "0000"), f))
        run(session(rule(MockTcpFault(delayMs = 700))))
        assertThat(slept).contains(700L)
        slept.clear()
        val (split, _) = run(session(rule(MockTcpFault(splitAt = 5))))
        assertThat(split.size).isEqualTo(12); assertThat(slept).isNotEmpty() // 8+4, 두 번에 나눠 씀
        val (corrupt, _) = run(session(rule(MockTcpFault(corruptLength = true))))
        assertThat(String(corrupt.copyOfRange(0, 4), Charsets.US_ASCII)).isEqualTo("0015") // 8+7
        val (drop, _) = run(session(rule(MockTcpFault(drop = true))))
        assertThat(drop).isEmpty(); assertThat(logs.last().note).contains("drop")
        val (rst, reset) = run(session(rule(MockTcpFault(reset = true))))
        assertThat(rst).isEmpty(); assertThat(reset).isTrue()
    }

    @Test
    fun `proxy - upstream 으로 통과, 양방향 로그, upstream 없음은 에러 로그`() {
        // 가짜 upstream: 요청을 읽고 0211 로 응답
        val toUp = PipedOutputStream(); val upIn = PipedInputStream(toUp, 1 shl 16)
        val fromUp = PipedOutputStream(); val upOut = PipedInputStream(fromUp, 1 shl 16)
        val t = Thread {
            val f = Framer.readFrame(upIn, spec)!!
            val d = ProtocolCodec.decode(spec, f.bytes, Direction.SEND)
            fromUp.write(ProtocolCodec.encode(spec, "0211", mapOf("응답코드" to "0000", "잔액" to d.body!!["계좌번호"]!!.take(3), "고객명" to "")).bytes); fromUp.flush()
        }.apply { isDaemon = true; start() }
        var closed = false
        val s = session(listOf(MockTcpRule("p", null, MockTcpThen("proxy")))) { TcpMockSession.Upstream(upOut, toUp) { closed = true } }
        val (resp, _) = run(s)
        t.join(2000)
        assertThat(ProtocolCodec.decode(spec, resp, Direction.RECV).body!!["잔액"]).isEqualTo("112")
        assertThat(logs.map { it.dir to it.source }).containsExactly("in" to "proxy", "out" to "proxy")
        assertThat(closed).isTrue() // 클라이언트 연결 종료 시 upstream 도 닫힘
        logs.clear()
        val (none, _) = run(session(listOf(MockTcpRule("p", null, MockTcpThen("proxy")))))
        assertThat(none).isEmpty(); assertThat(logs.last().level).isEqualTo("error"); assertThat(logs.last().note).contains("upstream")
    }

    @Test
    fun `깨진 길이 필드는 error 로그 + 원본 hex, 부분 수신은 chunks`() {
        val bad = ("0\" 1" + "0210" + "x".repeat(33)).toByteArray()
        run(session(emptyList()), bad)
        assertThat(logs.single().level).isEqualTo("error"); assertThat(logs.single().hex).startsWith("30 22 20 31")
        logs.clear()
        val s = session(listOf(MockTcpRule("fb", null, mock("거래코드" to "9001", "응답코드" to "0000"))))
        val out = ByteArrayOutputStream()
        val pin = PipedInputStream(1 shl 16); val pout = PipedOutputStream(pin)
        Thread { pout.write(req, 0, 10); pout.flush(); Thread.sleep(50); pout.write(req, 10, req.size - 10); pout.flush(); pout.close() }.start()
        s.serve(pin, out) {}
        assertThat(logs.first { it.dir == "in" }.chunks).hasSizeGreaterThan(1)
    }

    @Test
    fun `시크릿 값은 로그에서 마스킹`() {
        val s = TcpMockSession(spec, MockTcp(1, "p", null, null, listOf(MockTcpRule("r", null, mock("거래코드" to "9001", "응답코드" to "{{ apiKey@secret }}")))),
            ProtocolCodec.NO_PLUGINS, mapOf("apiKey" to "SECRET1"), { 1L }, { logs.add(it) }, { null }, mask = { it.replace("SECR", "••••") })
        run(s)
        assertThat(logs.last().text).doesNotContain("SECR")
    }
}
