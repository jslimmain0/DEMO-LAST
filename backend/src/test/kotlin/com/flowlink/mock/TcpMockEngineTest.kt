package com.flowlink.mock

import com.flowlink.mock.MockSpec.MockTcp
import com.flowlink.mock.MockSpec.MockTcpCond
import com.flowlink.mock.MockSpec.MockTcpReqField
import com.flowlink.mock.MockSpec.MockTcpRespField
import com.flowlink.mock.MockSpec.MockTcpRule
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.nio.charset.Charset

class TcpMockEngineTest {

    private val eucKr: Charset = Charset.forName("EUC-KR")
    private val layout = listOf(MockTcpReqField("a", "전문코드", 4), MockTcpReqField("b", "계좌", 10), MockTcpReqField("c", "고객명", 6))

    private fun tcp(rules: List<MockTcpRule>, prefix: Int = 4) =
        MockTcp(true, 9999, "EUC-KR", prefix, false, rules, layout)

    @Test
    fun `요청_레이아웃_바이트_슬라이싱_한글`() {
        val req = "02001234567890홍길동".toByteArray(eucKr) // 4 + 10 + 6
        val f = TcpMockEngine.sliceRequest(tcp(emptyList()), req, eucKr)
        assertThat(f.map { it.name to it.value }).containsExactly("전문코드" to "0200", "계좌" to "1234567890", "고객명" to "홍길동")
        assertThat(f.map { it.offset }).containsExactly(0, 4, 14)
        // 짧은 요청 — 범위 초과 필드는 빈 값(예외 없음)
        assertThat(TcpMockEngine.sliceRequest(tcp(emptyList()), "0200".toByteArray(eucKr), eucKr)[2].value).isEmpty()
    }

    @Test
    fun `필드_조건과_contains_AND_매칭`() {
        val bal = MockTcpRule("bal", "", null, listOf(MockTcpCond("전문코드", "eq", "0200")), null)
        val vip = MockTcpRule("vip", "홍", null, listOf(MockTcpCond("전문코드", "eq", "0200")), null)
        val def = MockTcpRule("def", "", "x", null, null)
        val rules = listOf(vip, bal, def)
        val hong = "02001234567890홍길동".toByteArray(eucKr)
        val kim = "02001234567890김철수".toByteArray(eucKr)
        val other = "09991234567890김철수".toByteArray(eucKr)
        fun m(req: ByteArray) = TcpMockEngine.matchRule(rules, String(req, eucKr), TcpMockEngine.sliceRequest(tcp(rules), req, eucKr))?.id
        assertThat(m(hong)).isEqualTo("vip")
        assertThat(m(kim)).isEqualTo("bal")
        assertThat(m(other)).isEqualTo("def")
        // 연산자
        val re = MockTcpRule("re", "", null, listOf(MockTcpCond("계좌", "regex", "^123")), null)
        val sw = MockTcpRule("sw", "", null, listOf(MockTcpCond("고객명", "startswith", "김")), null)
        assertThat(TcpMockEngine.matchRule(listOf(sw, re), "", TcpMockEngine.sliceRequest(tcp(rules), hong, eucKr))?.id).isEqualTo("re")
        assertThat(TcpMockEngine.matchRule(listOf(sw, re), "", TcpMockEngine.sliceRequest(tcp(rules), kim, eucKr))?.id).isEqualTo("sw")
    }

    @Test
    fun `필드명_토큰과_슬라이스_토큰_seq`() {
        val req = "02001234567890홍길동".toByteArray(eucKr)
        val f = TcpMockEngine.sliceRequest(tcp(emptyList()), req, eucKr)
        assertThat(TcpMockEngine.renderTemplate("0210{{req.계좌}}-{{ req.고객명 }}-{{req:0:4}}-{{seq}}", req, eucKr, f, 7L))
            .isEqualTo("02101234567890-홍길동-0200-7")
        assertThat(TcpMockEngine.renderTemplate("{{req.없음}}|", req, eucKr, f)).isEqualTo("|")
    }

    @Test
    fun `응답_필드_조립_패딩_절단_한글바이트`() {
        val rule = MockTcpRule("r", "", null, null, listOf(
            MockTcpRespField("1", "코드", 4, "0210"),
            MockTcpRespField("2", "계좌", 10, "{{req.계좌}}"),
            MockTcpRespField("3", "잔액", 12, "1500", "left", "0"),
            MockTcpRespField("4", "고객명", 10, "{{req.고객명}}"),          // 홍길동 6B + 공백 4
            MockTcpRespField("5", "메모", 4, "가나다"),                      // 6B → 4B 절단
        ))
        val req = "02001234567890홍길동".toByteArray(eucKr)
        val f = TcpMockEngine.sliceRequest(tcp(listOf(rule)), req, eucKr)
        val r = TcpMockEngine.render(rule, req, eucKr, f, 1L)
        assertThat(r.body.size).isEqualTo(4 + 10 + 12 + 10 + 4)
        assertThat(String(r.body.copyOfRange(0, 26), eucKr)).isEqualTo("02101234567890000000001500")
        assertThat(String(r.body.copyOfRange(26, 36), eucKr)).isEqualTo("홍길동    ")
        assertThat(r.body.copyOfRange(36, 40)).isEqualTo("가나".toByteArray(eucKr))
        val s = r.fields
        assertThat(s[2].padded).isTrue(); assertThat(s[2].pad).isEqualTo("left")
        assertThat(s[4].truncated).isTrue(); assertThat(s[4].actualBytes).isEqualTo(6)
        assertThat(s.map { it.offset }).containsExactly(0, 4, 14, 26, 36)
    }

    @Test
    fun `텍스트_모드_폴백과_미리보기_프리픽스`() {
        val text = MockTcpRule("t", "", "0000{{req:4:10}}", null, null)
        val p = TcpMockEngine.preview(tcp(listOf(text)), "02001234567890홍길동")
        assertThat(p.matchedRuleId).isEqualTo("t")
        assertThat(p.bodyBytes).isEqualTo(14)
        assertThat(p.totalBytes).isEqualTo(18)
        assertThat(p.printable).isEqualTo("001400001234567890")
        assertThat(p.hex).startsWith("30 30 31 34")
        assertThat(p.requestFields[2].value).isEqualTo("홍길동")
        assertThat(p.fields).isEmpty()
        // 필드 모드 미리보기 — 절대 오프셋(프리픽스 4 포함)
        val fr = MockTcpRule("f", "", null, null, listOf(MockTcpRespField("1", "코드", 4, "0210"), MockTcpRespField("2", "명", 6, "{{req.고객명}}")))
        val p2 = TcpMockEngine.preview(tcp(listOf(fr)), "02001234567890홍길동")
        assertThat(p2.fields.map { it.offset }).containsExactly(4, 8)
        assertThat(p2.printable).isEqualTo("00100210홍길동")
        // 무매칭 규칙 → 빈 본문
        val none = TcpMockEngine.preview(tcp(listOf(MockTcpRule("x", "ZZZ", "no", null, null))), "0200")
        assertThat(none.matchedRuleId).isNull(); assertThat(none.bodyBytes).isEqualTo(0)
    }

    @Test
    fun `과대_길이_가드`() {
        val big = MockTcpRule("b", "", null, null, listOf(MockTcpRespField("1", "x", 2_000_000, "")))
        assertThatThrownBy { TcpMockEngine.render(big, ByteArray(0), eucKr, emptyList(), 1L) }
            .isInstanceOf(IllegalArgumentException::class.java)
    }
}
