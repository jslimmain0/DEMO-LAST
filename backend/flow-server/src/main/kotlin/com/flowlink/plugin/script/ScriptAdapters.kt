package com.flowlink.plugin.script

import com.flowlink.transform.FlowTransform
import org.graalvm.polyglot.Source

/** 스크립트 객체에서 뽑은 메타 — kind = transform | fieldCodec | messageCodec. */
data class ScriptMeta(
    val id: String,
    val label: String,
    val description: String,
    val kind: String,
    val inputs: List<FlowTransform.IoSpec>,
    val outputs: List<FlowTransform.IoSpec>,
    val params: List<FlowTransform.TransformParam>,
) {
    companion object {
        const val TRANSFORM = "transform"; const val FIELD_CODEC = "fieldCodec"; const val MESSAGE_CODEC = "messageCodec"
        val KINDS = setOf(TRANSFORM, FIELD_CODEC, MESSAGE_CODEC)
        val ID = Regex("^[a-z0-9][a-z0-9-]{0,63}$")
    }
}

/** 컴파일 결과 — 메타 + 파싱된 소스(엔진이 AST 캐시). 호출은 ScriptRuntime.run* 로. */
class CompiledScript(val meta: ScriptMeta, internal val source: Source)

/** kind 에 맞는 SPI 구현체로 감싼다 — 레지스트리·실행 엔진·Mock·프로토콜은 스크립트 여부를 모른다. */
fun CompiledScript.toPlugin(rt: ScriptRuntime): Any = when (meta.kind) {
    ScriptMeta.FIELD_CODEC -> ScriptFieldCodec(this, rt)
    ScriptMeta.MESSAGE_CODEC -> ScriptMessageCodec(this, rt)
    else -> ScriptTransform(this, rt)
}

class ScriptTransform(private val cs: CompiledScript, private val rt: ScriptRuntime) : FlowTransform {
    override fun id() = cs.meta.id
    override fun label() = cs.meta.label
    override fun description() = cs.meta.description
    override fun inputs() = cs.meta.inputs
    override fun outputs() = cs.meta.outputs
    override fun params() = cs.meta.params
    override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> = rt.runTransform(cs, inputs, config).value
}

class ScriptFieldCodec(private val cs: CompiledScript, private val rt: ScriptRuntime) : com.flowlink.codec.FieldCodec {
    override fun id() = cs.meta.id
    override fun label() = cs.meta.label
    override fun params() = cs.meta.params
    override fun encode(value: String, ctx: com.flowlink.codec.CodecCtx) = rt.runFieldCodec(cs, value, "encode", ctx).value
    override fun decode(value: String, ctx: com.flowlink.codec.CodecCtx) = rt.runFieldCodec(cs, value, "decode", ctx).value
}

class ScriptMessageCodec(private val cs: CompiledScript, private val rt: ScriptRuntime) : com.flowlink.codec.MessageCodec {
    override fun id() = cs.meta.id
    override fun label() = cs.meta.label
    override fun params() = cs.meta.params
    override fun encode(body: ByteArray, ctx: com.flowlink.codec.CodecCtx) = rt.runMessageCodec(cs, "encode", body, ctx).value
    override fun decode(body: ByteArray, ctx: com.flowlink.codec.CodecCtx) = rt.runMessageCodec(cs, "decode", body, ctx).value
}
