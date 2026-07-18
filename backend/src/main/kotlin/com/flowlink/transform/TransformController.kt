package com.flowlink.transform

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.transform.FlowTransform.IoSpec
import com.flowlink.transform.FlowTransform.TransformParam
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 사용 가능한 변환 목록(내장+플러그인) + 미리보기 — 프론트 transform 노드 UI가 소비. */
@RestController
@RequestMapping("/api/v1/transforms")
class TransformController(private val registry: TransformRegistry) {

    private val mapper = ObjectMapper()

    data class TransformInfo(
        val id: String,
        val label: String,
        val description: String,
        val inputs: List<IoSpec>,
        val outputs: List<IoSpec>,
        val params: List<TransformParam>,
    ) {
        companion object {
            @JvmStatic
            fun from(t: FlowTransform): TransformInfo =
                TransformInfo(t.id(), t.label(), t.description(), t.inputs(), t.outputs(), t.params())
        }
    }

    @GetMapping
    fun list(): List<TransformInfo> = registry.list().map { TransformInfo.from(it) }

    data class PreviewRequest(val inputs: Map<String, String> = emptyMap(), val config: Map<String, String> = emptyMap())
    data class PreviewResponse(val ok: Boolean, val outputs: Map<String, Any?>, val error: String? = null)

    /**
     * 변환 미리보기(순수 계산 — 네트워크·DB 없음). 샘플 입력/설정으로 결과를 즉시 확인해 config 조정 루프를 닫는다.
     * 출력은 실행 엔진과 동일하게 타입 코어션(number/json)해 반환.
     */
    @PostMapping("/{id}/preview")
    fun preview(@PathVariable id: String, @RequestBody req: PreviewRequest): PreviewResponse {
        val t = registry.get(id).orElse(null)
            ?: return PreviewResponse(false, emptyMap(), "알 수 없는 변환: $id")
        return try {
            val out = t.apply(req.inputs, req.config)
            val types = t.outputs().associate { it.key to it.type }
            val coerced = LinkedHashMap<String, Any?>()
            for ((k, v) in out) coerced[k] = coerce(v, types[k] ?: "string")
            PreviewResponse(true, coerced)
        } catch (e: Exception) {
            PreviewResponse(false, emptyMap(), e.message ?: e.toString())
        }
    }

    private fun coerce(v: String, type: String): Any? = when (type) {
        "number" -> v.trim().toLongOrNull() ?: v.trim().toDoubleOrNull() ?: v
        "boolean" -> when (v.trim().lowercase()) { "true" -> true; "false" -> false; else -> v }
        "json", "array", "object" -> try { mapper.readTree(v) } catch (e: Exception) { v }
        else -> v
    }
}
