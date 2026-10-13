package com.flowlink.mock

import com.flowlink.common.json.JsonService
import com.flowlink.mock.MockDtos.CreateMockServerRequest
import com.flowlink.protocol.Direction
import com.flowlink.protocol.ProtocolCodec
import com.flowlink.protocol.ProtocolService
import com.flowlink.protocol.TcpClient
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.TestPropertySource
import java.net.SocketTimeoutException

/**
 * TCP Mock 전체 경로 — 실제 소켓으로 mock 응답 / upstream proxy 통과 / 장애 주입(split·corrupt-length·drop),
 * 그리고 관리 API(tcp-send·tcp-log·저장 검증·목록 프로토콜 이름)까지 한 번에.
 */
@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:tcpmocke2e;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
    "flowlink.mock.tcp.port-end=65535",
])
class TcpMockE2eTest {
    @Autowired lateinit var mocks: MockServerService
    @Autowired lateinit var protocols: ProtocolService
    @Autowired lateinit var registry: TcpMockRegistry
    @Autowired lateinit var json: JsonService

    private val specJson = """{"encoding":"EUC-KR","lengthField":"전문길이","discriminator":"거래코드",
        "header":[{"name":"전문길이","len":4,"type":"length"},{"name":"거래코드","len":4,"type":"ascii"}],
        "messages":[{"key":"0210","fields":[{"name":"계좌번호","len":13,"type":"ascii"}]},
                    {"key":"0211","fields":[{"name":"응답코드","len":4,"type":"ascii"},{"name":"잔액","len":15,"type":"numeric"}]},
                    {"key":"9001","fields":[{"name":"응답코드","len":4,"type":"ascii"}]}]}"""

    private fun tcpSpec(port: Int, pid: String, upstream: String?, rules: String) =
        json.readTree("""{"tcp":{"port":$port,"protocolId":"$pid","upstream":${upstream?.let { "\"$it\"" } ?: "null"},"timeoutMs":2000,"rules":[$rules]}}""")

    @Test
    fun `길이 필드 없는 4-way Mock 유지 연결은 정의 교체와 중지 시 즉시 닫힌다`() {
        val protocolJson = """{"encoding":"UTF-8","header":[],
            "framing":{"mode":"fixed","fixedLength":4},"responseFraming":{"mode":"fixed","fixedLength":6},
            "transport":{"connection":"execution","requestAckHex":"06","responseAckHex":"06"},
            "messages":[{"key":"request","fields":[{"name":"value","len":4,"type":"ascii"}]},
                        {"key":"response","fields":[{"name":"result","len":6,"type":"ascii"}]}]}"""
        val p = protocols.create("e2e-유지-고정", json.readTree(protocolJson))
        val spec = protocols.specOf(p.id)
        val port = registry.pickFreePort(19700)
        val m = mocks.create(CreateMockServerRequest("유지-고정", "e2e-tcp-keep-fixed", "TCP", null))
        var deleted = false
        try {
            mocks.updateSpec(m.id, tcpSpec(port, p.id.toString(), null,
                """{"id":"r","then":{"mode":"mock","fields":{"result":"{{req.value}}"}}}"""))
            TcpClient.Session("127.0.0.1", port, 2000).use { session ->
                repeat(2) {
                    val result = session.exchange("PING".toByteArray(), spec)
                    assertThat(ProtocolCodec.decode(spec, result.response.bytes, Direction.RECV).body!!["result"]).isEqualTo("PING")
                }
                mocks.updateSpec(m.id, tcpSpec(port, p.id.toString(), null,
                    """{"id":"r","then":{"mode":"mock","fields":{"result":"CHANGED"}}}"""))
                assertThatThrownBy { session.exchange("PING".toByteArray(), spec) }.isInstanceOf(java.io.IOException::class.java)
                assertThat(session.isClosed).isTrue()
            }
            TcpClient.Session("127.0.0.1", port, 2000).use { session ->
                val changed = session.exchange("PING".toByteArray(), spec)
                assertThat(ProtocolCodec.decode(spec, changed.response.bytes, Direction.RECV).body!!["result"]).isEqualTo("CHANGE")
                protocols.update(p.id, null, json.readTree(protocolJson.replace("\"fixedLength\":6", "\"fixedLength\":7").replace("\"len\":6", "\"len\":7")))
                assertThatThrownBy { session.exchange("PING".toByteArray(), spec) }.isInstanceOf(java.io.IOException::class.java)
            }
            val updatedSpec = protocols.specOf(p.id)
            val namedSpec = json.readTree("""{"resourceWorkspaceId":"public","tcp":{"port":$port,"protocolId":"${p.name}","rules":[{"id":"r","then":{"mode":"mock","fields":{"result":"CHANGED"}}}]}}""")
            mocks.updateSpec(m.id, namedSpec)
            TcpClient.Session("127.0.0.1", port, 2000).use { session ->
                assertThat(session.exchange("PING".toByteArray(), updatedSpec).response.bytes).hasSize(7)
                protocols.update(p.id, null, json.readTree(protocolJson.replace("\"fixedLength\":6", "\"fixedLength\":8").replace("\"len\":6", "\"len\":8")))
                assertThatThrownBy { session.exchange("PING".toByteArray(), updatedSpec) }.isInstanceOf(java.io.IOException::class.java)
            }
            val finalSpec = protocols.specOf(p.id)
            TcpClient.Session("127.0.0.1", port, 2000).use { session ->
                assertThat(session.exchange("PING".toByteArray(), finalSpec).response.bytes).hasSize(8)
                mocks.delete(m.id)
                deleted = true
                assertThat(registry.listeningPort(m.id)).isNull()
                assertThatThrownBy { session.exchange("PING".toByteArray(), finalSpec) }.isInstanceOf(java.io.IOException::class.java)
                assertThat(session.isClosed).isTrue()
            }
        } finally {
            if (!deleted) mocks.delete(m.id)
            protocols.delete(p.id)
        }
    }

    @Test
    fun `mock 응답 → proxy 통과 → 장애 주입 → tcp-send·tcp-log`() {
        val p = protocols.create("e2e-원장계", json.readTree(specJson))
        val spec = protocols.specOf(p.id)
        val pa = registry.pickFreePort(19600)
        val a = mocks.create(CreateMockServerRequest("A", "e2e-tcp-a", "TCP", null))
        // 갓 만든 TCP Mock 은 프로토콜이 없어 리스너를 안 연다 = OFF(고장 아님)
        val port0 = mocks.fleet().ports.first { it.mockId == a.id }
        assertThat(port0.state).isEqualTo("OFF"); assertThat(port0.error).isNull()
        assertThat(mocks.fleet().servers.first { it.id == a.id }.listenError).isNull()
        mocks.updateSpec(a.id, tcpSpec(pa, p.id.toString(), null, """
            {"id":"bal","when":[{"field":"거래코드","op":"eq","value":"0210"}],"then":{"mode":"mock","fields":{"거래코드":"0211","응답코드":"0000","잔액":"{{req.계좌번호}}"}}},
            {"id":"fb","when":[],"then":{"mode":"mock","fields":{"거래코드":"9001","응답코드":"9999"}}}"""))
        assertThat(registry.listeningPort(a.id)).isEqualTo(pa)

        val req = ProtocolCodec.encode(spec, "0210", mapOf("계좌번호" to "1122334567890")).bytes
        val r1 = ProtocolCodec.decode(spec, TcpClient.exchange("127.0.0.1", pa, 2000, req, spec).response.bytes, Direction.RECV)
        assertThat(r1.messageKey).isEqualTo("0211"); assertThat(r1.body!!["잔액"]).isEqualTo("1122334567890")

        // B: 0210 은 A 로 proxy, 나머지 mock. 0410 은 splitAt, 0510 은 corruptLength, 0610 은 drop
        val pb = registry.pickFreePort(pa + 1)
        val b = mocks.create(CreateMockServerRequest("B", "e2e-tcp-b", "TCP", null))
        mocks.updateSpec(b.id, tcpSpec(pb, p.id.toString(), "127.0.0.1:$pa", """
            {"id":"px","when":[{"field":"거래코드","op":"eq","value":"0210"}],"then":{"mode":"proxy"}},
            {"id":"sp","when":[{"field":"거래코드","op":"eq","value":"0410"}],"then":{"mode":"mock","fields":{"거래코드":"9001","응답코드":"SPLT"}},"fault":{"splitAt":6}},
            {"id":"cl","when":[{"field":"거래코드","op":"eq","value":"0510"}],"then":{"mode":"mock","fields":{"거래코드":"9001","응답코드":"CRPT"}},"fault":{"corruptLength":true}},
            {"id":"dr","when":[{"field":"거래코드","op":"eq","value":"0610"}],"then":{"mode":"mock","fields":{"거래코드":"9001","응답코드":"DROP"}},"fault":{"drop":true}}"""))
        val viaB = ProtocolCodec.decode(spec, TcpClient.exchange("127.0.0.1", pb, 2000, req, spec).response.bytes, Direction.RECV)
        assertThat(viaB.body!!["잔액"]).isEqualTo("1122334567890")
        val logB = mocks.tcpLog(b.id)
        assertThat(logB.map { it.dir to it.source }).contains("in" to "proxy", "out" to "proxy")
        assertThat(mocks.tcpLog(a.id).first { it.dir == "in" }.source).isEqualTo("mock")

        val split = TcpClient.exchange("127.0.0.1", pb, 3000, ProtocolCodec.encode(spec, "9001", mapOf("거래코드" to "0410", "응답코드" to "x")).bytes, spec)
        assertThat(split.response.partial).isTrue()
        val corrupt = ProtocolCodec.encode(spec, "9001", mapOf("거래코드" to "0510", "응답코드" to "x")).bytes
        assertThatThrownBy { TcpClient.exchange("127.0.0.1", pb, 1500, corrupt, spec) }.isInstanceOfAny(SocketTimeoutException::class.java, java.io.IOException::class.java)
        val drop = ProtocolCodec.encode(spec, "9001", mapOf("거래코드" to "0610", "응답코드" to "x")).bytes
        assertThatThrownBy { TcpClient.exchange("127.0.0.1", pb, 1000, drop, spec) }.isInstanceOf(SocketTimeoutException::class.java)

        // tcp-send(실제 소켓) + 미정의 전문 로그 + 저장 검증
        val sent = mocks.tcpSend(a.id, MockDtos.TcpSendRequest("0210", mapOf("계좌번호" to "999")))
        assertThat(sent.response.body!!["잔액"]).isEqualTo("999")
        assertThat(sent.response.partial).isFalse() // 한 번에 온 정상 왕복 — 청크가 헤더/본문 2개여도 부분 수신 아님
        val unknown = ProtocolCodec.encode(spec, "9001", mapOf("거래코드" to "0777", "응답코드" to "x")).bytes
        TcpClient.exchange("127.0.0.1", pa, 2000, unknown, spec)
        assertThat(mocks.tcpLog(a.id).first { it.dir == "in" }.note).contains("본문 스키마 없음")
        assertThatThrownBy { mocks.updateSpec(a.id, tcpSpec(pa, p.id.toString(), null, """{"id":"x","when":[],"then":{"mode":"proxy"}}""")) }.hasMessageContaining("upstream")
        assertThatThrownBy { mocks.updateSpec(a.id, tcpSpec(pa, p.id.toString(), null, """{"id":"x","when":[],"then":{"mode":"mock","fields":{"거래코드":"0211","없는필드":"1"}}}""")) }.hasMessageContaining("없는필드")
        // discriminator 를 안 정한 규칙은 저장 가능(응답 표는 요청 헤더 에코가 고른다) — 필드명 오타만 400
        mocks.updateSpec(a.id, tcpSpec(pa, p.id.toString(), null, """{"id":"echo","when":[],"then":{"mode":"mock","fields":{"응답코드":"0000"}}}"""))
        assertThat(ProtocolCodec.decode(spec, TcpClient.exchange("127.0.0.1", pa, 2000, req, spec).response.bytes, Direction.RECV).messageKey).isEqualTo("0210")
        val echo = ProtocolCodec.decode(spec, TcpClient.exchange("127.0.0.1", pa, 2000,
            ProtocolCodec.encode(spec, "9001", mapOf("응답코드" to "x")).bytes, spec).response.bytes, Direction.RECV)
        assertThat(echo.messageKey).isEqualTo("9001"); assertThat(echo.body!!["응답코드"]).isEqualTo("0000")
        assertThatThrownBy { mocks.updateSpec(a.id, tcpSpec(pa, p.id.toString(), null, """{"id":"x","when":[],"then":{"mode":"mock","fields":{"없는필드":"1"}}}""")) }.hasMessageContaining("어떤 전문에도 없는 필드")
        assertThat(mocks.list().first { it.id == a.id }.protocolName).isEqualTo("e2e-원장계")

        mocks.delete(b.id); mocks.delete(a.id)
        assertThat(registry.listeningPort(a.id)).isNull()
    }
}
