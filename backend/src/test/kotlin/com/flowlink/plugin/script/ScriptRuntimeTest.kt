package com.flowlink.plugin.script

import com.flowlink.codec.CodecCtx
import com.flowlink.plugin.PluginsProperties
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class ScriptRuntimeTest {
    private val rt = ScriptRuntime(PluginsProperties(script = PluginsProperties.Script(timeoutMs = 500, statementLimit = 200_000)))

    private val transformSrc = """
        ({ id: 'up', label: '대문자', inputs: [{ key: 'input', label: '원문' }], outputs: [{ key: 'result', label: '결과' }],
           params: [{ key: 'suffix', label: '접미', defaultValue: '!' }],
           apply(inputs, config) { fl.log('hi', 1); return { result: inputs.input.toUpperCase() + config.suffix, n: 3 } } })
    """.trimIndent()

    @Test
    fun `컴파일 - 메타 추출과 기본값`() {
        val cs = rt.compile(transformSrc)
        assertThat(cs.meta.id).isEqualTo("up"); assertThat(cs.meta.kind).isEqualTo("transform")
        assertThat(cs.meta.inputs.map { it.key }).containsExactly("input")
        assertThat(cs.meta.params.single().defaultValue).isEqualTo("!")
        val min = rt.compile("({ id: 'm', label: 'm', apply(i, c) { return { result: i.input } } })")
        assertThat(min.meta.inputs.map { it.key }).containsExactly("input"); assertThat(min.meta.outputs.map { it.key }).containsExactly("result")
    }

    @Test
    fun `transform 실행 - 문자열 아닌 출력은 JSON 문자열, 로그·시간 수집`() {
        val r = rt.runTransform(rt.compile(transformSrc), mapOf("input" to "ab"), mapOf("suffix" to "?"))
        assertThat(r.value).containsEntry("result", "AB?").containsEntry("n", "3")
        assertThat(r.logs).containsExactly("hi 1"); assertThat(r.durationMs).isGreaterThanOrEqualTo(0)
    }

    @Test
    fun `fieldCodec 과 messageCodec 실행`() {
        val fc = rt.compile("({ id: 'fc', kind: 'fieldCodec', encode(v, ctx) { return v + '|' + ctx.direction + '|' + ctx.field.len + '|' + ctx.message.acct }, decode(v, ctx) { return v.split('|')[0] } })")
        val ctx = CodecCtx(com.flowlink.codec.FieldInfo("acct", 13, "ascii", "right/space"), mapOf("acct" to "1"), mapOf("k" to "v"), "send")
        assertThat(rt.runFieldCodec(fc, "x", "encode", ctx).value).isEqualTo("x|send|13|1")
        assertThat(rt.runFieldCodec(fc, "x|send", "decode", ctx).value).isEqualTo("x")
        val mc = rt.compile("({ id: 'mc', kind: 'messageCodec', encode(b, ctx) { return b.map((x) => x + 1) }, decode(b, ctx) { return b.map((x) => x - 1) } })")
        val mctx = CodecCtx(null, emptyMap(), emptyMap(), "send")
        assertThat(rt.runMessageCodec(mc, "encode", byteArrayOf(1, 2, 255.toByte()), mctx).value).isEqualTo(byteArrayOf(2, 3, 0))
        assertThat(rt.runMessageCodec(mc, "decode", byteArrayOf(2, 3, 0), mctx).value).isEqualTo(byteArrayOf(1, 2, 255.toByte()))
    }

    @Test
    fun `컴파일 오류 - 문법 오류는 줄 번호, 메타 오류는 메시지`() {
        assertThatThrownBy { rt.compile("({ id: 'x',\n label: 'x' apply() {} })") }
            .isInstanceOf(ScriptError::class.java).matches { (it as ScriptError).line == 2 }
        assertThatThrownBy { rt.compile("({ id: 'Bad Id', label: 'x', apply() {} })") }.hasMessageContaining("id")
        assertThatThrownBy { rt.compile("({ id: 'x', label: 'x' })") }.hasMessageContaining("apply")
        assertThatThrownBy { rt.compile("({ id: 'x', label: 'x', kind: 'fieldCodec', encode(v) { return v } })") }.hasMessageContaining("decode")
        assertThatThrownBy { rt.compile("42") }.hasMessageContaining("객체")
    }

    @Test
    fun `샌드박스 - 호스트 접근 없음`() {
        for (expr in listOf("Java.type('java.lang.System')", "Polyglot.eval('js','1')", "java.lang.System", "new (Java.type('java.io.File'))('x')")) {
            val cs = rt.compile("({ id: 'x', label: 'x', apply(i, c) { return { result: String($expr) } } })")
            assertThatThrownBy { rt.runTransform(cs, emptyMap(), emptyMap()) }.isInstanceOf(ScriptError::class.java)
        }
        // typeof 로 확인 — 호스트 브릿지 전역이 존재하지 않는다
        val cs = rt.compile("({ id: 'x', label: 'x', apply(i, c) { return { result: typeof Java + ',' + typeof Polyglot + ',' + typeof fl } } })")
        assertThat(rt.runTransform(cs, emptyMap(), emptyMap()).value["result"]).isEqualTo("undefined,undefined,object")
    }

    @Test
    fun `타임아웃 - 무한루프는 상한 안에 실패`() {
        val cs = rt.compile("({ id: 'x', label: 'x', apply(i, c) { while (true) {} } })")
        val t0 = System.currentTimeMillis()
        assertThatThrownBy { rt.runTransform(cs, emptyMap(), emptyMap()) }.isInstanceOf(ScriptError::class.java).hasMessageContaining("시간")
        assertThat(System.currentTimeMillis() - t0).isLessThan(5000)
    }

    @Test
    fun `실행 중 예외는 ScriptError 로 - 줄 번호 포함`() {
        val cs = rt.compile("({ id: 'x', label: 'x',\n apply(i, c) {\n  throw new Error('boom') } })")
        assertThatThrownBy { rt.runTransform(cs, emptyMap(), emptyMap()) }.isInstanceOf(ScriptError::class.java)
            .hasMessageContaining("boom").matches { (it as ScriptError).line == 3 }
    }

    @Test
    fun `fl_b64 왕복`() {
        val cs = rt.compile("({ id: 'x', label: 'x', apply(i, c) { return { e: fl.b64.enc('한글'), d: fl.b64.dec(fl.b64.enc('한글')) } } })")
        val r = rt.runTransform(cs, emptyMap(), emptyMap()).value
        assertThat(r["e"]).isEqualTo("7ZWc6riA"); assertThat(r["d"]).isEqualTo("한글")
    }
}
