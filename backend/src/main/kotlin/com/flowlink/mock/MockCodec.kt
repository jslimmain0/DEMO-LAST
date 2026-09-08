package com.flowlink.mock

import com.flowlink.mock.MockSpec.MockCodecStep
import com.flowlink.transform.FlowTransform

/**
 * Mock 전문 코덱 — 요청 전문이 들어오기 전(request)·응답 전문이 나가기 전(response)에
 * 변환 플러그인([FlowTransform])을 순서대로 적용한다. 순수 함수(플러그인 조회는 람다 주입 — 게이트웨이/TCP 가
 * TransformRegistry 를 연결). 전문 전체가 하나의 문자열로 흐르며 단계마다 "첫 입력 포트 → 첫 출력 포트"가 기본.
 *
 * 실패(플러그인 없음·예외)는 [CodecException] — 코덱 실패는 전문 자체가 깨진 것이라 조용한 빈 문자열 대신 명시 실패.
 */
object MockCodec {

    class CodecException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

    /** 유효 코덱 — 라우트에 codec 이 있으면 통째로 라우트 것, 없으면 서버 것. */
    @JvmStatic
    fun effective(server: MockSpec.MockCodec?, route: MockSpec.MockCodec?): MockSpec.MockCodec? = route ?: server

    /** 단계들을 순서대로 적용한 전문. 단계가 없으면 원문 그대로. */
    @JvmStatic
    fun run(steps: List<MockCodecStep>?, text: String, lookup: (String) -> FlowTransform?): String {
        if (steps.isNullOrEmpty()) return text
        var cur = text
        for ((i, step) in steps.withIndex()) {
            val id = step.id?.trim().orEmpty()
            if (id.isEmpty()) continue // 빈 단계(편집 중 미선택)는 건너뜀
            val t = lookup(id) ?: throw CodecException("코덱 ${i + 1}단계: 알 수 없는 변환 플러그인 '$id'")
            val inKey = step.inputKey?.takeIf { it.isNotBlank() } ?: t.inputs().firstOrNull()?.key ?: "input"
            val outKey = step.outputKey?.takeIf { it.isNotBlank() } ?: t.outputs().firstOrNull()?.key ?: "result"
            val config = LinkedHashMap<String, String>()
            for (kv in step.config ?: emptyList()) {
                val k = kv.key ?: continue
                config[k] = kv.value ?: ""
            }
            val out = try {
                t.apply(mapOf(inKey to cur), config)
            } catch (e: Exception) {
                throw CodecException("코덱 ${i + 1}단계('$id') 실패: ${e.message ?: e.toString()}", e)
            }
            cur = out[outKey] ?: out.values.firstOrNull()
                ?: throw CodecException("코덱 ${i + 1}단계('$id'): 출력 '$outKey' 없음")
        }
        return cur
    }
}
