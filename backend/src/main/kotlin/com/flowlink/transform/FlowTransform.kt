package com.flowlink.transform

/**
 * 변환(transform) SPI. 내장 변환과 JAR 플러그인이 동일하게 구현한다.
 *
 * 플러그인은 [inputs]/[outputs] 로 **입력/출력 개수와 이름**을 직접 선언하고,
 * [apply] 에서 이름별 입력을 받아 이름별 출력을 돌려준다. 속성 패널은 선언된 입력 수만큼
 * 바인딩 칸을 그리고, 선언된 출력은 하위 노드에서 바인딩 가능해진다.
 *
 * JAR 작성: 이 인터페이스를 구현하고 `META-INF/services/com.flowlink.transform.FlowTransform`
 * 에 클래스명을 등록하면 ServiceLoader로 로드된다. (신뢰 JAR 전용 — 샌드박스 없음)
 */
interface FlowTransform {

    /** 고유 식별자(노드의 transformId 와 매칭). */
    fun id(): String

    /** UI 표시 이름. */
    fun label(): String

    /** 입력 포트 선언(개수/이름/타입). 기본: 단일 입력 "input". */
    fun inputs(): List<IoSpec> = listOf(IoSpec.of("input", "입력"))

    /** 출력 포트 선언(개수/이름/타입). 기본: 단일 출력 "result". */
    fun outputs(): List<IoSpec> = listOf(IoSpec.of("result", "결과"))

    /** 설정 파라미터 스키마(UI 폼 생성용). */
    fun params(): List<TransformParam> = listOf()

    /** 이름별 입력 → 이름별 출력. (선언한 outputs 의 key 로 결과를 담아 반환) */
    fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String>

    /** 입력/출력 포트 정의. */
    data class IoSpec(val key: String, val label: String, val type: String) {
        companion object {
            @JvmStatic
            fun of(key: String, label: String): IoSpec = IoSpec(key, label, "string")
        }
    }

    data class TransformParam(val key: String, val label: String, val type: String, val defaultValue: String) {
        companion object {
            @JvmStatic
            fun of(key: String, label: String): TransformParam = TransformParam(key, label, "string", "")

            @JvmStatic
            fun of(key: String, label: String, defaultValue: String): TransformParam =
                TransformParam(key, label, "string", defaultValue)
        }
    }
}
