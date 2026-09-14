package com.flowlink.mock

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.mock.MockHttp.MockRequest
import com.flowlink.mock.MockSpec.KV
import com.flowlink.mock.MockSpec.MockCodecInput
import com.flowlink.mock.MockSpec.MockCodecStep
import com.flowlink.transform.FlowTransform
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

/** 코덱 v2 — 입력 포트 값(시크릿 토큰)·출력 포트·v1 호환. */
class MockCodecV2Test {

    private val mapper = ObjectMapper()

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
    private val lookup: (String) -> FlowTransform? = { if (it == "joiner") joiner else null }

    private fun step(id: String, target: String? = null, fields: List<String>? = null, header: String? = null, inputs: List<MockCodecInput>? = null, cfg: List<Pair<String, String>> = emptyList(), outputKey: String? = null) =
        MockCodecStep(id, cfg.map { KV(it.first, it.second) }, null, outputKey, target, fields, header, inputs)

    private fun req(body: String, ct: String = "application/json", headers: Map<String, String> = emptyMap()): MockRequest {
        val h = LinkedHashMap<String, String>(); h["content-type"] = ct; h.putAll(headers)
        return MockRequest("POST", "/x", emptyMap(), h, body, MockHttp.parseBodyFields(body, ct, Charsets.UTF_8, mapper))
    }

    private val ctx = MockContext(secrets = mapOf("hmacKey" to "K1"), json = mapper)

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
    fun `v1_호환_inputKey_outputKey_와_알수없는_플러그인`() {
        val legacy = MockCodecStep("joiner", null, "key", "joined", null, null, null, null)
        assertThat(MockCodec.applyStep(legacy, 0, "M", ctx, lookup)).isEqualTo("|M") // inputKey 포트 = message
        assertThatThrownBy { MockCodec.run(listOf(step("nope")), "x", lookup) }.isInstanceOf(MockCodec.CodecException::class.java).hasMessageContaining("nope")
        assertThatThrownBy { MockCodec.applyRequest(listOf(step("joiner", target = "header")), req("x"), ctx, lookup, mapper) }
            .isInstanceOf(MockCodec.CodecException::class.java).hasMessageContaining("헤더")
    }
}
