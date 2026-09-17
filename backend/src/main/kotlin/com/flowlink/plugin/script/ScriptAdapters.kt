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
