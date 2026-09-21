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

    private fun step(id: String, action: String, message: String?, fields: Map<String, String> = emptyMap(), expect: List<MockTcpCond> = emptyList(), timeoutMs: Int? = null) =
        MockSpec.MockTcpStep(id, action, message, fields, expect, timeoutMs)
    /** session 모드 세션 — 단계 타임아웃은 기록만 하고 스트림에 강제하지 않는다(테스트는 스트림으로 상황을 만든다). */
    private fun sessionMode(rules: List<MockTcpRule>, input: java.io.InputStream, timeouts: MutableList<Int> = ArrayList()): Pair<ByteArray, Boolean> {
        val tcp = MockTcp(9600, "p", null, 1000, rules, "session", 700)
        val out = ByteArrayOutputStream(); var reset = false
        TcpMockSession(spec, tcp, ProtocolCodec.NO_PLUGINS, mapOf("apiKey" to "SECRET1"), { 1001L }, { logs.add(it) }, { null },
            sleeper = { slept.add(it) }, setTimeout = { timeouts.add(it) }).serve(input, out) { reset = true }
        return out.toByteArray() to reset
    }
    private fun frames(vararg b: ByteArray) = ByteArrayInputStream(b.reduce { a, x -> a + x })

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
    fun `then 없는 규칙도 drop, reset 은 동작`() {
        val (rst, reset) = run(session(listOf(MockTcpRule("r", null, null, MockTcpFault(reset = true)))))
        assertThat(rst).isEmpty(); assertThat(reset).isTrue()
        assertThat(logs.none { it.level == "error" }).isTrue() // "응답 전문 정의 없음" 오해 로그가 없어야 한다
        logs.clear()
        val (drop, _) = run(session(listOf(MockTcpRule("r", null, null, MockTcpFault(drop = true)))))
        assertThat(drop).isEmpty()
        assertThat(logs.last().level).isEqualTo("warn"); assertThat(logs.last().note).contains("drop")
        logs.clear()
        val (none, _) = run(session(listOf(MockTcpRule("r", null, null, null))))
        assertThat(none).isEmpty(); assertThat(logs.last().note).contains("then 없음")
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
        assertThat(logs.last().hex).isEmpty() // 마스킹된 행은 hex 로도 원문이 새면 안 된다
        assertThat(logs.last().note).contains("hex 생략")
    }

    // ---------- connectionMode=session 시퀀스 ----------

    private val seqRule = MockTcpRule("s1", listOf(cond("거래코드", "0210")), MockTcpThen("mock", null, listOf(
        step("ack", "send", "9001", mapOf("응답코드" to "0000")),
        step("res", "send", "0211", mapOf("응답코드" to "0000", "잔액" to "{{seq}}", "고객명" to "{{initial.고객명}}")),
        step("fin", "receive", "0210", expect = listOf(MockTcpCond("계좌번호", "eq", "{{initial.계좌번호}}"))),
    )))

    @Test
    fun `session - send·receive 를 같은 연결에서 순서대로, initial 템플릿과 단계 로그`() {
        val fin = ProtocolCodec.encode(spec, "0210", mapOf("계좌번호" to "1122334567890", "고객명" to "김철수")).bytes
        val (out, reset) = sessionMode(listOf(seqRule), frames(req, fin))
        assertThat(reset).isFalse()
        // 보낸 프레임 2개(9001 → 0211)
        val ins = out.inputStream()
        val f1 = ProtocolCodec.decode(spec, Framer.readFrame(ins, spec)!!.bytes, Direction.RECV)
        val f2 = ProtocolCodec.decode(spec, Framer.readFrame(ins, spec)!!.bytes, Direction.RECV)
        assertThat(f1.messageKey).isEqualTo("9001"); assertThat(f1.body!!["응답코드"]).isEqualTo("0000")
        assertThat(f2.messageKey).isEqualTo("0211"); assertThat(f2.body!!["고객명"]).isEqualTo("김철수")
        // 단계 로그 — id·방향·연결 식별자
        val steps = logs.filter { it.stepId != null }
        assertThat(steps.map { it.stepId to it.dir }).containsExactly("ack" to "out", "res" to "out", "fin" to "in")
        assertThat(steps.map { it.connId }.distinct()).hasSize(1)
        assertThat(steps.last().fields["계좌번호"]).isEqualTo("1122334567890")
        assertThat(logs.none { it.level == "error" }).isTrue()
    }

    @Test
    fun `session - 이전 단계 수신값을 {{steps}} 로 참조한다`() {
        val rule = MockTcpRule("s2", null, MockTcpThen("mock", null, listOf(
            step("first", "receive", "0210"),
            step("echo", "send", "0211", mapOf("응답코드" to "0000", "잔액" to "1", "고객명" to "{{steps.first.고객명}}")),
        )))
        // 규칙을 깨우는 프레임(0210) → 단계1 이 또 하나의 0210 을 받고 → 그 값으로 응답
        val second = ProtocolCodec.encode(spec, "0210", mapOf("계좌번호" to "9", "고객명" to "이영희")).bytes
        val (out, _) = sessionMode(listOf(rule), frames(req, second))
        val d = ProtocolCodec.decode(spec, Framer.readFrame(out.inputStream(), spec)!!.bytes, Direction.RECV)
        assertThat(d.body!!["고객명"]).isEqualTo("이영희")
    }

    @Test
    fun `session - partial read 를 누적해 프레임을 조립한다`() {
        val fin = ProtocolCodec.encode(spec, "0210", mapOf("계좌번호" to "1122334567890", "고객명" to "김철수")).bytes
        val all = req + fin
        // 1바이트씩만 주는 스트림 — Framer 가 모아야 한다
        val dribble = object : java.io.InputStream() {
            private var i = 0
            override fun read(): Int = if (i < all.size) all[i++].toInt() and 0xff else -1
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (i >= all.size) return -1
                b[off] = all[i++]; return 1
            }
        }
        val (out, _) = sessionMode(listOf(seqRule), dribble)
        assertThat(Framer.readFrame(out.inputStream(), spec)).isNotNull()
        val recv = logs.first { it.stepId == "fin" }
        assertThat(recv.partial).isTrue()
        assertThat(recv.fields["계좌번호"]).isEqualTo("1122334567890")
        assertThat(logs.none { it.level == "error" }).isTrue()
    }

    @Test
    fun `session - 단계 타임아웃·조건 불일치·해석 실패는 세션 실패로 끝난다`() {
        // (1) 타임아웃 — 소켓처럼 SocketTimeoutException 을 던지는 스트림
        val timeouts = ArrayList<Int>()
        val stalled = object : java.io.InputStream() {
            private val head = req
            private var i = 0
            override fun read(): Int = if (i < head.size) head[i++].toInt() and 0xff else throw java.net.SocketTimeoutException("Read timed out")
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (i >= head.size) throw java.net.SocketTimeoutException("Read timed out")
                val n = minOf(len, head.size - i); System.arraycopy(head, i, b, off, n); i += n; return n
            }
        }
        sessionMode(listOf(seqRule), stalled, timeouts)
        assertThat(logs.last().level).isEqualTo("error")
        assertThat(logs.last().note).contains("수신 타임아웃").contains("700") // sessionTimeoutMs
        assertThat(logs.last().stepId).isEqualTo("fin")
        assertThat(timeouts).contains(700)

        // (2) 조건 불일치
        logs.clear()
        val other = ProtocolCodec.encode(spec, "0210", mapOf("계좌번호" to "0000000000000", "고객명" to "김철수")).bytes
        sessionMode(listOf(seqRule), frames(req, other))
        assertThat(logs.last().note).contains("조건 불일치").contains("계좌번호")
        assertThat(logs.last().level).isEqualTo("error")

        // (3) 단계 타임아웃 덮어쓰기
        logs.clear()
        val t2 = ArrayList<Int>()
        val rule = MockTcpRule("s3", null, MockTcpThen("mock", null, listOf(step("wait", "receive", "0210", timeoutMs = 120))))
        sessionMode(listOf(rule), object : java.io.InputStream() {
            private var i = 0
            override fun read(): Int = if (i < req.size) req[i++].toInt() and 0xff else throw java.net.SocketTimeoutException("x")
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (i >= req.size) throw java.net.SocketTimeoutException("x")
                val n = minOf(len, req.size - i); System.arraycopy(req, i, b, off, n); i += n; return n
            }
        }, t2)
        assertThat(t2).contains(120)
    }

    @Test
    fun `session - 연결마다 상태가 격리된다`() {
        val rule = MockTcpRule("iso", null, MockTcpThen("mock", null, listOf(
            step("r", "receive", "0210"),
            step("s", "send", "0211", mapOf("응답코드" to "0000", "잔액" to "1", "고객명" to "{{steps.r.고객명}}")),
        )))
        val a = ProtocolCodec.encode(spec, "0210", mapOf("계좌번호" to "1", "고객명" to "가")).bytes
        val b = ProtocolCodec.encode(spec, "0210", mapOf("계좌번호" to "2", "고객명" to "나")).bytes
        val (outA, _) = sessionMode(listOf(rule), frames(req, a))
        val (outB, _) = sessionMode(listOf(rule), frames(req, b))
        val da = ProtocolCodec.decode(spec, Framer.readFrame(outA.inputStream(), spec)!!.bytes, Direction.RECV)
        val db = ProtocolCodec.decode(spec, Framer.readFrame(outB.inputStream(), spec)!!.bytes, Direction.RECV)
        assertThat(da.body!!["고객명"]).isEqualTo("가")
        assertThat(db.body!!["고객명"]).isEqualTo("나")
        assertThat(logs.mapNotNull { it.connId }.distinct()).hasSize(2) // 연결 두 개가 섞이지 않는다
    }
}
