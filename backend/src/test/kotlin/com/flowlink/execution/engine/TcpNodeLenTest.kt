package com.flowlink.execution.engine

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.config.ExecutionProperties
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.charset.Charset

/**
 * 워크플로 TCP 노드 요청 필드의 전문 길이 토큰 — `{{len}}`(요청 필드 선언 길이 합)·`{{len:4}}`·`{{len:frame}}`.
 * 전송 없이 [TcpNodeExecutor.build]/[TcpNodeExecutor.preview] 로 조립 바이트만 검증(미리보기도 같은 경로).
 */
class TcpNodeLenTest {

    private val mapper = jacksonObjectMapper()
    private val json = JsonService(mapper)
    private val tokens = TokenResolver(json)
    private val props = ExecutionProperties(null, null, null, null, 0)
    private val executor = TcpNodeExecutor(tokens, SsrfGuard(props), json)
    private val euc: Charset = Charset.forName("EUC-KR")

    private fun node(vararg fields: String, prefix: Int = 4, includesSelf: Boolean = false): GraphNode = mapper.readValue(
        """
        {"id":"t1","type":"tcp","tcpHost":"127.0.0.1","tcpPort":9999,"tcpEncoding":"EUC-KR",
         "tcpPrefixLength":$prefix,"tcpPrefixIncludesSelf":$includesSelf,
         "tcpRequest":[${fields.joinToString(",")}]}
        """.trimIndent(),
        GraphNode::class.java,
    )

    private fun field(name: String, len: Int, value: String, pad: String = "right", padChar: String = " ") =
        """{"id":"$name","name":"$name","length":$len,"value":"$value","pad":"$pad","padChar":"$padChar"}"""

    @Test
    fun `요청 필드의 len 4 는 선언 길이 합으로 조립된다`() {
        // 4(전문길이) + 4(전문코드) + 6(고객명) = 14바이트
        val n = node(
            field("전문길이", 4, "{{len:4}}", "left", "0"),
            field("전문코드", 4, "0200"),
            field("고객명", 6, "홍길동"),
        )
        val b = executor.build(n, ExecutionContext())
        assertThat(b.bodySize).isEqualTo(14)
        assertThat(String(b.message, euc)).isEqualTo("0014" + "0014" + "0200" + "홍길동") // 프리픽스 + 본문
        assertThat(b.slices[0].text).isEqualTo("0014")
        assertThat(b.slices[0].truncated).isFalse()
        assertThat(b.slices[0].padded).isFalse()
    }

    @Test
    fun `frame 은 프리픽스를 더한 값 - 프리픽스가 없으면 본문 길이`() {
        val withPrefix = executor.build(node(field("길이", 4, "{{len:frame:4}}"), field("코드", 4, "0200")), ExecutionContext())
        assertThat(String(withPrefix.message, euc)).isEqualTo("0008" + "0012" + "0200") // 본문 8 + 프리픽스 4 = 12

        val noPrefix = executor.build(node(field("길이", 4, "{{len:frame:4}}"), field("코드", 4, "0200"), prefix = 0), ExecutionContext())
        assertThat(String(noPrefix.message, euc)).isEqualTo("0008" + "0200")
    }

    @Test
    fun `bare len 과 텍스트 혼합, 다른 토큰과 함께 쓰기`() {
        val n = node(
            field("길이", 8, "LEN={{len}}"),
            field("계좌", 10, "{{ acct@n0 }}"),
        )
        val b = executor.build(n, ExecutionContext().also { it.putOutput("n0", mapOf("acct" to "1234567890")) })
        assertThat(b.bodySize).isEqualTo(18)
        assertThat(String(b.message, euc)).isEqualTo("0018" + "LEN=18  " + "1234567890")
    }

    @Test
    fun `한글(EUC-KR 2바이트) 길이도 바이트 기준, 미리보기도 같은 값`() {
        val n = node(field("길이", 4, "{{len:4}}", "left", "0"), field("고객명", 6, "홍길동"))
        val b = executor.build(n, ExecutionContext())
        assertThat(b.bodySize).isEqualTo(10)
        assertThat(String(b.message, euc)).isEqualTo("0010" + "0010" + "홍길동")

        val p = executor.preview(n, ExecutionContext())
        assertThat(p.bodyBytes).isEqualTo(10)
        assertThat(p.totalBytes).isEqualTo(14)
        assertThat(p.fields[0].text).isEqualTo("0010")
        assertThat(p.declaredPrefix).isEqualTo(10)
    }

    @Test
    fun `길이 토큰이 없으면 기존 동작 그대로(무회귀)`() {
        val n = node(field("길이", 4, "0200"), field("고객명", 6, "홍길동"))
        assertThat(String(executor.build(n, ExecutionContext()).message, euc)).isEqualTo("0010" + "0200" + "홍길동")
        // len 이 아닌 미해석 토큰은 기존대로 빈 문자열(패딩)
        val unknown = node(field("길이", 4, "{{length}}"))
        assertThat(String(executor.build(unknown, ExecutionContext()).message, euc)).isEqualTo("0004" + "    ")
    }
}
