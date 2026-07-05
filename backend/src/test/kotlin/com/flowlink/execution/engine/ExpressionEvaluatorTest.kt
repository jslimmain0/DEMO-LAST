package com.flowlink.execution.engine

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.json.JsonService
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** IF 표현식 샌드박스 — 정상 비교는 평가하고, 임의 코드 실행은 막는지 검증. */
class ExpressionEvaluatorTest {

    private val json = JsonService(ObjectMapper())
    private val evaluator = ExpressionEvaluator(TokenResolver(json))

    private fun ctxWith(output: Map<String, Any>): ExecutionContext {
        val ctx = ExecutionContext()
        ctx.putOutput("n1", output)
        return ctx
    }

    @Test
    fun notNullComparison() {
        val ctx = ctxWith(mapOf("id" to 1, "name" to "kim"))
        assertTrue(evaluator.evaluateBoolean("{{ id@n1 }} != null", ctx))
    }

    @Test
    fun numericEquality() {
        val ctx = ctxWith(mapOf("id" to 1))
        assertTrue(evaluator.evaluateBoolean("{{ id@n1 }} == 1", ctx))
        assertFalse(evaluator.evaluateBoolean("{{ id@n1 }} == 2", ctx))
    }

    @Test
    fun missingValueIsNull() {
        val ctx = ctxWith(mapOf("id" to 1))
        assertFalse(evaluator.evaluateBoolean("{{ missing@n1 }} != null", ctx))
    }

    @Test
    fun blankConditionPasses() {
        assertTrue(evaluator.evaluateBoolean("", ExecutionContext()))
    }

    @Test
    fun maliciousExpressionDoesNotExecuteAndReturnsFalse() {
        val ctx = ctxWith(mapOf("id" to 1))
        // 타입 참조/메서드 호출은 SimpleEvaluationContext 에서 차단됨 → 예외 → false 폴백
        assertFalse(evaluator.evaluateBoolean("T(java.lang.System).exit(0) == null", ctx))
        assertFalse(evaluator.evaluateBoolean("''.getClass().getName() == 'x'", ctx))
    }
}
