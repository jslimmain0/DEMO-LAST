package com.flowlink.plugin.script

import com.flowlink.codec.CodecCtx
import com.flowlink.codec.FieldCodec
import com.flowlink.codec.FieldInfo
import com.flowlink.codec.MessageCodec
import com.flowlink.plugin.PluginsProperties
import com.flowlink.transform.FlowTransform
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class ScriptAdaptersTest {
    private val rt = ScriptRuntime(PluginsProperties())

    @Test
    fun `transform 어댑터 - SPI 메타와 apply 위임`() {
        val p = rt.compile("({ id: 't1', label: '라벨', description: '설명', inputs: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], outputs: [{ key: 'sum', label: '합', type: 'number' }], params: [{ key: 'k', label: 'K', defaultValue: '1' }], apply(i, c) { return { sum: Number(i.a) + Number(i.b) + Number(c.k) } } })").toPlugin(rt)
        assertThat(p).isInstanceOf(FlowTransform::class.java)
        val t = p as FlowTransform
        assertThat(t.id()).isEqualTo("t1"); assertThat(t.label()).isEqualTo("라벨"); assertThat(t.description()).isEqualTo("설명")
        assertThat(t.inputs().map { it.key }).containsExactly("a", "b"); assertThat(t.outputs().single().type).isEqualTo("number")
        assertThat(t.params().single().defaultValue).isEqualTo("1")
        assertThat(t.apply(mapOf("a" to "1", "b" to "2"), mapOf("k" to "3"))).containsEntry("sum", "6")
        assertThat(t.apply(mapOf("a" to "x"), emptyMap())).containsEntry("sum", "null") // NaN → JSON.stringify → "null"
    }

    @Test
    fun `fieldCodec 어댑터`() {
        val p = rt.compile("({ id: 'f1', label: 'F', kind: 'fieldCodec', params: [{ key: 'n', label: 'N', defaultValue: '2' }], encode(v, ctx) { return fl.mask(v, 0, Number(ctx.config.n)) }, decode(v, ctx) { return v.replace(/\\*/g, '') } })").toPlugin(rt)
        val fc = p as FieldCodec
        val ctx = CodecCtx(FieldInfo("acct", 10, "ascii", "right/space"), emptyMap(), mapOf("n" to "3"), "send")
        assertThat(fc.id()).isEqualTo("f1"); assertThat(fc.params().single().key).isEqualTo("n")
        assertThat(fc.encode("123456", ctx)).isEqualTo("***456"); assertThat(fc.decode("***456", ctx)).isEqualTo("456")
    }

    @Test
    fun `messageCodec 어댑터 - 바이트 왕복`() {
        val p = rt.compile("({ id: 'm1', label: 'M', kind: 'messageCodec', encode(b, ctx) { return fl.aes.encryptBytes(b, ctx.config.key, ctx.config.iv) }, decode(b, ctx) { return fl.aes.decryptBytes(b, ctx.config.key, ctx.config.iv) } })").toPlugin(rt)
        val mc = p as MessageCodec
        val ctx = CodecCtx(null, emptyMap(), mapOf("key" to "0123456789abcdef", "iv" to "0000000000000000"), "send")
        val body = "본문".toByteArray(Charsets.UTF_8)
        val enc = mc.encode(body, ctx)
        assertThat(enc).isNotEqualTo(body); assertThat(mc.decode(enc, ctx)).isEqualTo(body)
    }
}
