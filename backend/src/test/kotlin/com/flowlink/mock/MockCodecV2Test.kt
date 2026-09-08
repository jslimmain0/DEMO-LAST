package com.flowlink.mock

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.mock.MockHttp.MockRequest
import com.flowlink.mock.MockSpec.KV
import com.flowlink.mock.MockSpec.MockCodecInput
import com.flowlink.mock.MockSpec.MockCodecStep
import com.flowlink.mock.MockSpec.MockTcp
import com.flowlink.mock.MockSpec.MockTcpReqField
import com.flowlink.mock.MockSpec.MockTcpRespField
import com.flowlink.mock.MockSpec.MockTcpRule
import com.flowlink.transform.BuiltinTransforms
import com.flowlink.transform.FlowTransform
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.util.Base64

/** 코덱 v2 — 적용 범위(body/fields/header)·입력 포트 값(시크릿 토큰)·HTTP/TCP. */
class MockCodecV2Test {

    private val mapper = ObjectMapper()
    private val builtin = BuiltinTransforms.all().associateBy { it.id() }

    /** 두 입력(text, key)을 "text|key" 로 합치고 두 출력을 내는 가짜 플러그인 — 포트 지정 검증용. */
    private val joiner = object : FlowTransform {
        override fun id() = "joiner"
        override fun label() = "joiner"
        override fun inputs() = listOf(FlowTransform.IoSpec.of("text", "T"), FlowTransform.IoSpec.of("key", "K"))
        override fun outputs() = listOf(FlowTransform.IoSpec.of("joined", "J"), FlowTransform.IoSpec.of("len", "L", "number"))
        override fun params() = listOf(FlowTransform.TransformParam.of("sep", "구분자", "|"))
        override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> {
            val j = (inputs["text"] ?: "") + (config["sep"] ?: "|") + (inputs["key"] ?: "")
            return mapOf("joined" to j, "len" to j.length.toString())
        }
    }
    private val lookup: (String) -> FlowTransform? = { if (it == "joiner") joiner else builtin[it] }

    private fun step(id: String, target: String? = null, fields: List<String>? = null, header: String? = null, inputs: List<MockCodecInput>? = null, cfg: List<Pair<String, String>> = emptyList(), outputKey: String? = null) =
        MockCodecStep(id, cfg.map { KV(it.first, it.second) }, null, outputKey, target, fields, header, inputs)

    private fun req(body: String, ct: String = "application/json", headers: Map<String, String> = emptyMap()): MockRequest {
        val h = LinkedHashMap<String, String>(); h["content-type"] = ct; h.putAll(headers)
        return MockRequest("POST", "/x", emptyMap(), h, body, MockHttp.parseBodyFields(body, ct, Charsets.UTF_8, mapper))
    }

    private val ctx = MockContext(secrets = mapOf("hmacKey" to "K1"), json = mapper)
    private val b64 = { s: String -> Base64.getEncoder().encodeToString(s.toByteArray()) }

    @Test
    fun `입력_포트_message_value_시크릿_토큰_파라미터_템플릿_출력_포트`() {
        val s = step("joiner", inputs = listOf(MockCodecInput("key", "value", "{{ hmacKey@secret }}"), MockCodecInput("text", "message")), cfg = listOf("sep" to "-"))
        assertThat(MockCodec.applyStep(s, 0, "MSG", ctx, lookup)).isEqualTo("MSG-K1")
        val s2 = step("joiner", inputs = listOf(MockCodecInput("key", "value", "{{ hmacKey@secret }}")), outputKey = "len")
        assertThat(MockCodec.applyStep(s2, 0, "MSG", ctx, lookup)).isEqualTo("6") // 첫 포트(text)=message 기본, 출력 len
        // 포트 미지정 → 첫 포트 message, 나머지 빈 값
        assertThat(MockCodec.applyStep(step("joiner"), 0, "M", ctx, lookup)).isEqualTo("M|")
    }

    @Test
    fun `HTTP_요청_fields_대상_JSON_점경로_와_urlencoded`() {
        val enc = b64("1234-5678")
        val r = req("""{"card":{"no":"$enc","cvc":"$enc"},"amt":"100"}""")
        val steps = listOf(step("base64-decode", target = "fields", fields = listOf("card.no", "card.zzz")))
        val trace = ArrayList<MockCodec.StepTrace>()
        val out = MockCodec.applyRequest(steps, r, ctx, lookup, mapper, trace)
        assertThat(out.bodyText).isEqualTo("""{"card":{"no":"1234-5678","cvc":"$enc"},"amt":"100"}""") // 지정 필드만, 없는 필드는 건너뜀
        assertThat(out.bodyFields["amt"]).isEqualTo("100")
        assertThat(trace).hasSize(1); assertThat(trace[0].field).isEqualTo("card.no")
        // urlencoded
        val f = req("pin=${b64("0000")}&a=1", "application/x-www-form-urlencoded")
        val out2 = MockCodec.applyRequest(listOf(step("base64-decode", target = "fields", fields = listOf("pin"))), f, ctx, lookup, mapper)
        assertThat(out2.bodyFields["pin"]).isEqualTo("0000"); assertThat(out2.bodyText).isEqualTo("pin=0000&a=1")
    }

    @Test
    fun `HTTP_요청_header_대상과_body_체인_순서`() {
        val r = req(b64("hello"), "text/plain", mapOf("x-token" to b64("tok")))
        val steps = listOf(step("base64-decode", target = "header", header = "X-Token"), step("base64-decode"), step("upper"))
        val out = MockCodec.applyRequest(steps, r, ctx, lookup, mapper)
        assertThat(out.headers["x-token"]).isEqualTo("tok")
        assertThat(out.bodyText).isEqualTo("HELLO") // body 단계끼리 체인(decode → upper)
        // 없는 헤더는 건너뜀(오류 아님)
        val out2 = MockCodec.applyRequest(listOf(step("upper", target = "header", header = "X-None")), r, ctx, lookup, mapper)
        assertThat(out2.headers).doesNotContainKey("x-none")
    }

    @Test
    fun `HTTP_응답_fields_header_서명_body`() {
        val headers = LinkedHashMap<String, String>()
        val rendered = """{"ok":true,"user":{"name":"kim"},"amt":"100"}"""
        val steps = listOf(
            step("base64-encode", target = "fields", fields = listOf("user.name")),
            step("joiner", target = "header", header = "X-Sig", inputs = listOf(MockCodecInput("key", "value", "{{ hmacKey@secret }}")), cfg = listOf("sep" to "#")),
            step("upper"),
        )
        val out = MockCodec.applyResponse(steps, rendered, headers, "json", ctx, lookup, mapper)
        val encName = b64("kim")
        assertThat(headers["X-Sig"]).isEqualTo("""{"ok":true,"user":{"name":"$encName"},"amt":"100"}#K1""") // 헤더 단계 입력 = 그 시점의 본문
        assertThat(out).isEqualTo("""{"ok":true,"user":{"name":"$encName"},"amt":"100"}""".uppercase())
    }

    @Test
    fun `응답_fields_는_JSON_urlencoded_만_그외_오류`() {
        val headers = LinkedHashMap<String, String>()
        assertThatThrownBy { MockCodec.applyResponse(listOf(step("upper", target = "fields", fields = listOf("a"))), "<x>1</x>", headers, "xml", ctx, lookup, mapper) }
            .isInstanceOf(MockCodec.CodecException::class.java)
        assertThat(MockCodec.applyResponse(listOf(step("upper", target = "fields", fields = listOf("a"))), "a=x&b=y", headers, "urlencoded", ctx, lookup, mapper)).isEqualTo("a=X&b=y")
    }

    @Test
    fun `v1_호환_inputKey_outputKey_와_알수없는_플러그인`() {
        val legacy = MockCodecStep("joiner", null, "key", "joined", null, null, null, null)
        assertThat(MockCodec.applyStep(legacy, 0, "M", ctx, lookup)).isEqualTo("|M") // inputKey 포트 = message
        assertThatThrownBy { MockCodec.run(listOf(step("nope")), "x", lookup) }.isInstanceOf(MockCodec.CodecException::class.java).hasMessageContaining("nope")
        assertThatThrownBy { MockCodec.applyRequest(listOf(step("upper", target = "header")), req("x"), ctx, lookup, mapper) }
            .isInstanceOf(MockCodec.CodecException::class.java).hasMessageContaining("헤더")
    }

    @Test
    fun `TCP_요청_fields_와_body_응답_fields_패딩전_과_body`() {
        val euc = charset("EUC-KR")
        val tcp = MockTcp(true, 1, "EUC-KR", 4, false,
            listOf(MockTcpRule("r", "", null, null, listOf(
                MockTcpRespField("1", "코드", 4, "0210"),
                MockTcpRespField("2", "계좌", 10, "{{ 계좌@req }}"),
                MockTcpRespField("3", "키", 6, "{{ hmacKey@secret }}"),
            ))),
            listOf(MockTcpReqField("q1", "전문코드", 4), MockTcpReqField("q2", "계좌", 10)))
        // 요청: 계좌 필드만 base64 디코딩(레이아웃은 인코딩된 길이 기준), 응답: 계좌 필드 upper(패딩 전) + 전체 base64
        val encAcct = b64("12345") // 8 chars
        val tcp2 = tcp.copy(requestFields = listOf(MockTcpReqField("q1", "전문코드", 4), MockTcpReqField("q2", "계좌", 8)))
        val codec = MockSpec.MockCodec(
            request = listOf(step("base64-decode", target = "fields", fields = listOf("계좌"))),
            response = listOf(step("upper", target = "fields", fields = listOf("계좌")), step("base64-encode")),
        )
        val p = TcpMockEngine.process(tcp2, codec, ("0200$encAcct").toByteArray(euc), euc, 5L, mapOf("hmacKey" to "K1"), lookup)
        assertThat(p.reqFields.first { it.name == "계좌" }.value).isEqualTo("12345")
        val body = String(Base64.getDecoder().decode(String(p.body, euc)), euc)
        assertThat(body).isEqualTo("0210" + "12345     " + "K1    ") // 계좌 upper(숫자라 동일)·시크릿 값 6B 패딩
        assertThat(p.traces.map { it.target }).containsExactly("fields", "fields", "body")
        // body 요청 코덱: 전체 디코딩 후 레이아웃 재슬라이스
        val whole = b64("02001234567890")
        val p2 = TcpMockEngine.process(tcp, MockSpec.MockCodec(request = listOf(step("base64-decode"))), whole.toByteArray(euc), euc, 1L, emptyMap(), lookup)
        assertThat(p2.reqText).isEqualTo("02001234567890"); assertThat(p2.reqFields[1].value).isEqualTo("1234567890")
    }
}
