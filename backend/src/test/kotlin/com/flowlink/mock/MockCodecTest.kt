package com.flowlink.mock

import com.flowlink.mock.MockSpec.KV
import com.flowlink.mock.MockSpec.MockCodecStep
import com.flowlink.transform.FlowTransform
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class MockCodecTest {

    private val lookup: (String) -> FlowTransform? = { null }

    private fun step(id: String, vararg cfg: Pair<String, String>, inputKey: String? = null, outputKey: String? = null) =
        MockCodecStep(id, cfg.map { KV(it.first, it.second) }, inputKey, outputKey)

    @Test
    fun `단계_없으면_원문_그대로`() {
        assertThat(MockCodec.run(null, "abc", lookup)).isEqualTo("abc")
        assertThat(MockCodec.run(emptyList(), "abc", lookup)).isEqualTo("abc")
    }

    @Test
    fun `다중_포트_플러그인은_키_지정`() {
        val multi = object : FlowTransform {
            override fun id() = "multi"
            override fun label() = "multi"
            override fun inputs() = listOf(FlowTransform.IoSpec.of("left", "L"), FlowTransform.IoSpec.of("right", "R"))
            override fun outputs() = listOf(FlowTransform.IoSpec.of("a", "A"), FlowTransform.IoSpec.of("b", "B"))
            override fun apply(inputs: Map<String, String>, config: Map<String, String>) =
                mapOf("a" to "A:" + (inputs["left"] ?: ""), "b" to "B:" + (inputs["right"] ?: ""))
        }
        val lk: (String) -> FlowTransform? = { if (it == "multi") multi else null }
        assertThat(MockCodec.run(listOf(step("multi", inputKey = "right", outputKey = "b")), "x", lk)).isEqualTo("B:x")
        // 키 미지정 = 첫 입력/첫 출력
        assertThat(MockCodec.run(listOf(step("multi")), "x", lk)).isEqualTo("A:x")
    }

    @Test
    fun `알_수_없는_플러그인은_예외`() {
        assertThatThrownBy { MockCodec.run(listOf(step("nope")), "x", lookup) }
            .isInstanceOf(MockCodec.CodecException::class.java)
            .hasMessageContaining("nope")
    }

    @Test
    fun `플러그인_예외는_단계_정보와_함께_전파`() {
        val boom = object : FlowTransform {
            override fun id() = "boom"
            override fun label() = "boom"
            override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> =
                throw IllegalStateException("bad key")
        }
        assertThatThrownBy { MockCodec.run(listOf(step("boom")), "x") { if (it == "boom") boom else null } }
            .isInstanceOf(MockCodec.CodecException::class.java)
            .hasMessageContaining("boom").hasMessageContaining("bad key")
    }
}
