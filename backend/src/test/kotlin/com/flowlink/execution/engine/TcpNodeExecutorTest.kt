package com.flowlink.execution.engine

import com.flowlink.common.json.JsonService
import com.flowlink.protocol.ProtocolCodec
import com.flowlink.protocol.ProtocolService
import com.flowlink.protocol.ProtocolSpec
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.TestPropertySource
import java.net.ServerSocket

@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:tcpnode;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
    "spring.flyway.enabled=false", "spring.jpa.hibernate.ddl-auto=create-drop",
])
class TcpNodeExecutorTest {
    @Autowired lateinit var executor: TcpNodeExecutor
    @Autowired lateinit var protocols: ProtocolService
    @Autowired lateinit var json: JsonService

    private val specJson = """{"encoding":"EUC-KR","lengthField":"전문길이","discriminator":"거래코드",
        "header":[{"name":"전문길이","len":4,"type":"length"},{"name":"거래코드","len":4,"type":"ascii"}],
        "messages":[{"key":"0210","fields":[{"name":"계좌번호","len":13,"type":"ascii"},{"name":"고객명","len":10,"type":"string"}]},
                    {"key":"0211","fields":[{"name":"응답코드","len":4,"type":"ascii"},{"name":"잔액","len":15,"type":"numeric"}]}]}"""

    private fun node(pid: String, values: Map<String, String>, port: Int, msg: String = "0210") = json.mapper().readValue("""
        {"id":"t1","type":"tcp","tcpHost":"127.0.0.1","tcpPort":$port,"tcpTimeoutMs":3000,"protocolId":"$pid","tcpMessage":"$msg",
         "tcpValues":${json.toJson(values)}}""", com.flowlink.core.graph.GraphNode::class.java)

    /** 가짜 서버 — 요청 1개 받고 [respond](기본: 0211 응답, 잔액=요청 계좌번호 앞 7자리) 후 종료. */
    private fun fakeServer(
        spec: ProtocolSpec,
        respond: (ProtocolCodec.Decoded) -> ProtocolCodec.Encoded = { d -> ProtocolCodec.encode(spec, "0211", mapOf("응답코드" to "0000", "잔액" to d.body!!["계좌번호"]!!.take(7))) },
        body: () -> Unit,
    ) {
        ServerSocket(0).use { ss ->
            val t = Thread {
                ss.accept().use { s ->
                    val f = com.flowlink.protocol.Framer.readFrame(s.getInputStream(), spec)!!
                    val d = ProtocolCodec.decode(spec, f.bytes, com.flowlink.protocol.Direction.SEND)
                    val resp = respond(d)
                    s.getOutputStream().apply { write(resp.bytes); flush() }
                }
            }.apply { isDaemon = true; start() }
            port = ss.localPort
            body()
            t.join(3000)
        }
    }
    private var port = 0

    @Test
    fun `프로토콜로 조립·전송·해석 - 출력은 헤더+본문 필드`() {
        val p = protocols.create("원장계-노드", json.readTree(specJson))
        val spec = protocols.specOf(p.id)
        fakeServer(spec) {
            val r = executor.execute(node(p.id.toString(), mapOf("계좌번호" to "1122334567890", "고객명" to "김철수"), port), ExecutionContext())
            assertThat(r.ok).withFailMessage(r.responseText).isTrue()
            @Suppress("UNCHECKED_CAST")
            val out = r.value as Map<String, Any?>
            assertThat(out["거래코드"]).isEqualTo("0211")
            assertThat(out["응답코드"]).isEqualTo("0000")
            assertThat(out["잔액"]).isEqualTo("1122334")
            assertThat(r.requestText).contains("0210").contains("김철수")
        }
    }

    @Test
    fun `미리보기 - 검증 오류는 errors, 정상은 hex`() {
        val p = protocols.create("원장계-미리보기", json.readTree(specJson))
        val ok = executor.preview(node(p.id.toString(), mapOf("계좌번호" to "1", "고객명" to "a"), 1), ExecutionContext())
        assertThat(ok.errors).isEmpty(); assertThat(ok.total).isEqualTo(31)
        val bad = executor.preview(node(p.id.toString(), mapOf("계좌번호" to "한글"), 1), ExecutionContext())
        assertThat(bad.errors.map { it.field }).containsExactly("계좌번호")
        val none = executor.preview(node("00000000-0000-0000-0000-000000000000", emptyMap(), 1), ExecutionContext())
        assertThat(none.errors[0].message).contains("프로토콜")
    }

    @Test
    fun `정의되지 않은 응답 전문은 헤더 + body raw 로 성공`() {
        val p = protocols.create("원장계-미정의응답", json.readTree(specJson))
        val spec = protocols.specOf(p.id)
        fakeServer(spec, respond = { ProtocolCodec.encode(spec, "0211", mapOf("거래코드" to "0777", "응답코드" to "0000", "잔액" to "1")) }) {
            val r = executor.execute(node(p.id.toString(), mapOf("계좌번호" to "1122334567890", "고객명" to "김철수"), port), ExecutionContext())
            assertThat(r.ok).withFailMessage(r.responseText).isTrue()
            @Suppress("UNCHECKED_CAST")
            val out = r.value as Map<String, Any?>
            assertThat(out["거래코드"]).isEqualTo("0777")
            assertThat(out).containsKey("body")
            assertThat(r.responseText).contains("정의되지 않은 전문")
        }
    }

    @Test
    fun `프로토콜 없음·전송 실패는 노드 실패 메시지`() {
        val r = executor.execute(node("00000000-0000-0000-0000-000000000000", emptyMap(), 1), ExecutionContext())
        assertThat(r.ok).isFalse(); assertThat(r.responseText).contains("프로토콜")
        val p = protocols.create("원장계-실패", json.readTree(specJson))
        val r2 = executor.execute(node(p.id.toString(), mapOf("계좌번호" to "1"), 1), ExecutionContext()) // 포트 1 — 연결 거부
        assertThat(r2.ok).isFalse(); assertThat(r2.responseText).contains("TCP 요청 실패")
    }
}
