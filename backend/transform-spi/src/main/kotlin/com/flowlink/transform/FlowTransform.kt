package com.flowlink.transform

/**
 * 변환(transform) SPI. 내장 변환과 JAR 플러그인이 동일하게 구현한다.
 *
 * 플러그인은 [inputs]/[outputs] 로 **입력/출력 개수와 이름**을 직접 선언하고,
 * [apply] 에서 이름별 입력을 받아 이름별 출력을 돌려준다. 속성 패널은 선언된 입력 수만큼
 * 바인딩 칸을 그리고, 선언된 출력은 하위 노드에서 바인딩 가능해진다.
 *
 * 출력 IoSpec.type 이 number/boolean/json/array 면 실행 엔진이 문자열 결과를 그 네이티브 타입으로
 * 코어션해 다운스트림에 싣는다(assert 숫자 비교·JSON 재추출 성립). string(기본)은 무변경.
 *
 * JAR 작성: 이 인터페이스를 구현하고 `META-INF/services/com.flowlink.transform.FlowTransform`
 * 에 클래스명을 등록하면 ServiceLoader로 로드된다. (신뢰 JAR 전용 — 샌드박스 없음)
 */
interface FlowTransform {

    /** 고유 식별자(노드의 transformId 와 매칭). */
    fun id(): String

    /** UI 표시 이름. */
    fun label(): String

    /** 한 줄 설명(무엇을 넣으면 무엇이 나오는지). 속성 패널 안내용. */
    fun description(): String = ""

    /** 입력 포트 선언(개수/이름/타입). 기본: 단일 입력 "input". */
    fun inputs(): List<IoSpec> = listOf(IoSpec.of("input", "입력"))

    /** 출력 포트 선언(개수/이름/타입). 기본: 단일 출력 "result". */
    fun outputs(): List<IoSpec> = listOf(IoSpec.of("result", "결과"))

    /** 설정 파라미터 스키마(UI 폼 생성용). */
    fun params(): List<TransformParam> = listOf()

    /** 이름별 입력 → 이름별 출력. (선언한 outputs 의 key 로 결과를 담아 반환) */
    fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String>

    /** 입력/출력 포트 정의. [type]=string|number|boolean|json|array. [example] 은 UI 힌트. */
    data class IoSpec(val key: String, val label: String, val type: String, val example: String = "") {
        companion object {
            @JvmStatic
            fun of(key: String, label: String): IoSpec = IoSpec(key, label, "string")

            @JvmStatic
            fun of(key: String, label: String, type: String): IoSpec = IoSpec(key, label, type)
        }
    }

    /**
     * 설정 파라미터. [type]=string|number|select|textarea. select 면 [options] 중 하나를 고른다.
     * [placeholder] 는 입력 힌트.
     */
    data class TransformParam(
        val key: String,
        val label: String,
        val type: String,
        val defaultValue: String,
        val options: List<String> = emptyList(),
        val placeholder: String = "",
    ) {
        companion object {
            @JvmStatic
            fun of(key: String, label: String): TransformParam = TransformParam(key, label, "string", "")

            @JvmStatic
            fun of(key: String, label: String, defaultValue: String): TransformParam =
                TransformParam(key, label, "string", defaultValue)

            /** 숫자 입력 파라미터. */
            @JvmStatic
            fun number(key: String, label: String, defaultValue: String): TransformParam =
                TransformParam(key, label, "number", defaultValue)

            /** 드롭다운 선택 파라미터. */
            @JvmStatic
            fun select(key: String, label: String, options: List<String>, defaultValue: String): TransformParam =
                TransformParam(key, label, "select", defaultValue, options)

            /** 힌트(placeholder) 있는 문자열 파라미터. */
            @JvmStatic
            fun hint(key: String, label: String, defaultValue: String, placeholder: String): TransformParam =
                TransformParam(key, label, "string", defaultValue, emptyList(), placeholder)
        }
    }
}
