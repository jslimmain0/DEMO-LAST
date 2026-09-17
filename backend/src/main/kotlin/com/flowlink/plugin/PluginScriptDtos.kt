package com.flowlink.plugin

import com.flowlink.plugin.script.ScriptMeta
import com.flowlink.transform.FlowTransform
import java.time.Instant
import java.util.UUID

object PluginScriptDtos {
    data class MetaView(val id: String, val label: String, val description: String, val kind: String,
                        val inputs: List<FlowTransform.IoSpec>, val outputs: List<FlowTransform.IoSpec>, val params: List<FlowTransform.TransformParam>) {
        companion object { fun of(m: ScriptMeta) = MetaView(m.id, m.label, m.description, m.kind, m.inputs, m.outputs, m.params) }
    }
    data class Summary(
        val id: UUID, val pluginId: String, val name: String, val kind: String, val status: String,
        /** 승인본이 서빙 중인가 */ val live: Boolean,
        /** 초안이 승인본과 다른가(수정 중) */ val dirty: Boolean,
        val usages: Int, val updatedAt: Instant?, val submittedBy: String?, val createdBy: String,
    )
    data class Detail(
        val id: UUID, val pluginId: String, val name: String, val kind: String, val status: String, val live: Boolean, val dirty: Boolean,
        val usages: Int, val updatedAt: Instant?, val submittedBy: String?, val submittedAt: Instant?, val createdBy: String,
        val source: String, val liveSource: String?, val sampleJson: String?, val reviewNote: String?, val reviewedBy: String?, val reviewedAt: Instant?,
        /** 초안의 컴파일 메타(컴파일 실패면 null — 저장 시점엔 항상 성공하므로 보통 있음) */ val meta: MetaView?,
    )
    data class SaveRequest(val name: String? = null, val source: String? = null)
    /** 초안 1회 실행. 입력이 하나도 없으면 컴파일만(meta). transform: inputs/config · fieldCodec: value+fn+direction(+message) · messageCodec: bytesB64+fn. */
    data class TryRequest(
        val source: String? = null, val inputs: Map<String, String>? = null, val config: Map<String, String>? = null,
        val value: String? = null, val fn: String? = null, val direction: String? = null, val message: Map<String, String>? = null, val bytesB64: String? = null,
    )
    data class TryResult(val meta: MetaView, val outputs: Map<String, String>? = null, val result: String? = null, val bytesB64: String? = null,
                         val logs: List<String> = emptyList(), val durationMs: Long = 0)
    data class ReviewRequest(val note: String? = null)
    data class ScriptErrorBody(val message: String, val line: Int?, val col: Int?)
}
