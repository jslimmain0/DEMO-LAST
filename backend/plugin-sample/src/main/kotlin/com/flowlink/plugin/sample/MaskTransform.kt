package com.flowlink.plugin.sample

import com.flowlink.transform.FlowTransform
import com.flowlink.transform.FlowTransform.IoSpec
import com.flowlink.transform.FlowTransform.TransformParam

/**
 * 개인정보 마스킹 — 앞/뒤 일부만 남기고 가운데를 마스킹 문자로 가린다.
 * 예: 1234567890123456 (keepFront=6, keepBack=4) → 123456******3456
 *
 * 단일 입력/단일 출력 + 설정 파라미터 3개를 쓰는 가장 기본형 플러그인 예시.
 */
class MaskTransform : FlowTransform {

    override fun id(): String = "mask"

    override fun label(): String = "마스킹(플러그인)"

    override fun inputs(): List<IoSpec> = listOf(IoSpec.of("input", "원문"))

    override fun outputs(): List<IoSpec> = listOf(IoSpec.of("result", "마스킹 결과"))

    override fun params(): List<TransformParam> = listOf(
        TransformParam.of("keepFront", "앞에 남길 글자 수", "3"),
        TransformParam.of("keepBack", "뒤에 남길 글자 수", "4"),
        TransformParam.of("maskChar", "마스킹 문자", "*"),
    )

    override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> {
        val s = inputs["input"] ?: ""
        val front = intOf(config["keepFront"], 3).coerceAtLeast(0)
        val back = intOf(config["keepBack"], 4).coerceAtLeast(0)
        val mask = (config["maskChar"] ?: "*").ifEmpty { "*" }.first()
        // 남길 길이가 원문 이상이면 전체 마스킹 — 짧은 값이 그대로 노출되지 않게
        val masked = if (s.isEmpty() || front + back >= s.length) {
            mask.toString().repeat(s.length)
        } else {
            s.take(front) + mask.toString().repeat(s.length - front - back) + s.takeLast(back)
        }
        return mapOf("result" to masked)
    }

    private fun intOf(v: String?, def: Int): Int = v?.trim()?.toIntOrNull() ?: def
}
