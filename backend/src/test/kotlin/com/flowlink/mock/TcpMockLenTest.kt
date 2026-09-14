package com.flowlink.mock

import com.flowlink.mock.MockSpec.MockTcp
import com.flowlink.mock.MockSpec.MockTcpReqField
import com.flowlink.mock.MockSpec.MockTcpRespField
import com.flowlink.mock.MockSpec.MockTcpRule
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.charset.Charset

/**
 * TCP mock 응답의 전문 길이 토큰 — 필드 모드(선언 길이 합)와 템플릿 모드(2패스) 모두
 * "전문 안의 길이 필드"가 실제 전송 바이트와 일치하는지 검증. 미리보기도 같은 경로([TcpMockEngine.process]).
 */
class TcpMockLenTest {

    private val euc: Charset = Charset.forName("EUC-KR")

    private fun reqField(name: String, len: Int) = MockTcpReqField(name, name, len, null)

    private fun tcp(rules: List<MockTcpRule>, prefixLength: Int? = 4, includesSelf: Boolean? = false) = MockTcp(
        enabled = true, port = 19999, charset = "EUC-KR", prefixLength = prefixLength, prefixIncludesSelf = includesSelf,
        requestFields = listOf(reqField("구분", 4)), rules = rules,
    )

    private fun respField(name: String, len: Int, value: String, pad: String? = null, padChar: String? = null) =
        MockTcpRespField(name, name, len, value, pad, padChar, null)

    private fun rule(id: String, fields: List<MockTcpRespField>? = null, response: String? = null) =
        MockTcpRule(id, null, response, null, fields)

    @Test
    fun `필드 모드 - len 은 응답 필드 선언 길이의 합`() {
        // 4(길이) + 4(구분) + 6(금액) = 14바이트
        val r = rule("ok", listOf(
            respField("전문길이", 4, "{{len:4}}", "left", "0"),
            respField("구분", 4, "0210"),
            respField("금액", 6, "{{len}}", "left", "0"),
        ))
        val rendered = TcpMockEngine.render(rule = r, req = "0200".toByteArray(euc), cs = euc, reqFields = emptyList(), seq = 1L, prefixLen = 4)
        val body = String(rendered.body, euc)
        assertThat(rendered.body.size).isEqualTo(14)
        assertThat(body).isEqualTo("0014" + "0210" + "000014")
        assertThat(body.substring(0, 4).toInt()).isEqualTo(rendered.body.size)
    }

    @Test
    fun `필드 모드 - frame 은 프리픽스를 더한다`() {
        val r = rule("ok", listOf(respField("전문길이", 4, "{{len:frame:4}}"), respField("구분", 4, "0210")))
        val rendered = TcpMockEngine.render(rule = r, req = ByteArray(0), cs = euc, reqFields = emptyList(), seq = 1L, prefixLen = 4)
        assertThat(String(rendered.body, euc)).isEqualTo("00120210") // 본문 8 + 프리픽스 4
        // 프리픽스가 없으면 frame = len
        val none = TcpMockEngine.render(rule = r, req = ByteArray(0), cs = euc, reqFields = emptyList(), seq = 1L, prefixLen = 0)
        assertThat(String(none.body, euc)).isEqualTo("00080210")
    }

    @Test
    fun `템플릿 모드 - 다른 토큰이 렌더된 뒤 2패스로 길이 확정`() {
        val r = rule("ok", response = "{{len:4}}0210{{req:0:4}}홍길동")
        val rendered = TcpMockEngine.render(rule = r, req = "0200".toByteArray(euc), cs = euc, reqFields = emptyList(), seq = 1L, prefixLen = 4)
        val body = String(rendered.body, euc)
        assertThat(body).isEqualTo("00180210" + "0200" + "홍길동") // 4+4+4+6 = 18바이트
        assertThat(body.substring(0, 4).toInt()).isEqualTo(rendered.body.size)
    }

    @Test
    fun `전체 경로(process) - 리스너·미리보기가 같은 값`() {
        val r = rule("ok", listOf(respField("전문길이", 4, "{{len:4}}"), respField("구분", 4, "0210"), respField("고객", 6, "홍길동")))
        val spec = tcp(listOf(r))
        val p = TcpMockEngine.process(spec, null, "0200".toByteArray(euc), euc, 1L)
        assertThat(p.body.size).isEqualTo(14)
        assertThat(String(p.body, euc)).startsWith("00140210")

        val pv = TcpMockEngine.preview(spec, "0200")
        assertThat(pv.bodyBytes).isEqualTo(14)
        assertThat(pv.totalBytes).isEqualTo(18) // 프리픽스 4 포함
        assertThat(pv.printable).isEqualTo("0014" + "00140210" + "홍길동")
        assertThat(pv.fields[0].text).isEqualTo("0014")
    }

    @Test
    fun `미리보기 - 템플릿 모드도 길이가 실제 전송 바이트와 일치`() {
        val spec = tcp(listOf(rule("ok", response = "{{len:frame:4}}0210OK")))
        val pv = TcpMockEngine.preview(spec, "0200")
        assertThat(pv.bodyBytes).isEqualTo(10)
        assertThat(pv.totalBytes).isEqualTo(14)
        assertThat(pv.printable).isEqualTo("0010" + "00140210OK") // 프리픽스(본문길이 10) + 본문(frame=14)
    }

    @Test
    fun `알 수 없는 토큰은 기존 규약대로 - len 이 아닌 것은 영향 없음`() {
        val r = rule("ok", response = "{{length}}|{{없는키}}|{{len:4}}")
        val rendered = TcpMockEngine.render(rule = r, req = ByteArray(0), cs = euc, reqFields = emptyList(), seq = 1L, prefixLen = 4)
        // {{length}} 는 MockTemplate 의 미해석 토큰 → 빈 문자열(기존 규약), {{len:4}} 만 길이로 치환
        assertThat(String(rendered.body, euc)).isEqualTo("||0006")
    }

    @Test
    fun `HTTP 문맥에는 길이 토큰이 없다(무회귀)`() {
        assertThat(MockTemplate.render("{{len:4}}", MockContext())).isEmpty()
    }
}
