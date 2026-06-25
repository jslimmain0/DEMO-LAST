package com.flowlink.execution.engine;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.flowlink.common.json.JsonService;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** IF 표현식 샌드박스 — 정상 비교는 평가하고, 임의 코드 실행은 막는지 검증. */
class ExpressionEvaluatorTest {

    private final JsonService json = new JsonService(new ObjectMapper());
    private final ExpressionEvaluator evaluator = new ExpressionEvaluator(new TokenResolver(json));

    private ExecutionContext ctxWith(Map<String, Object> output) {
        ExecutionContext ctx = new ExecutionContext();
        ctx.putOutput("n1", output);
        return ctx;
    }

    @Test
    void notNullComparison() {
        ExecutionContext ctx = ctxWith(Map.of("id", 1, "name", "kim"));
        assertTrue(evaluator.evaluateBoolean("{{ id@n1 }} != null", ctx));
    }

    @Test
    void numericEquality() {
        ExecutionContext ctx = ctxWith(Map.of("id", 1));
        assertTrue(evaluator.evaluateBoolean("{{ id@n1 }} == 1", ctx));
        assertFalse(evaluator.evaluateBoolean("{{ id@n1 }} == 2", ctx));
    }

    @Test
    void missingValueIsNull() {
        ExecutionContext ctx = ctxWith(Map.of("id", 1));
        assertFalse(evaluator.evaluateBoolean("{{ missing@n1 }} != null", ctx));
    }

    @Test
    void blankConditionPasses() {
        assertTrue(evaluator.evaluateBoolean("", new ExecutionContext()));
    }

    @Test
    void maliciousExpressionDoesNotExecuteAndReturnsFalse() {
        ExecutionContext ctx = ctxWith(Map.of("id", 1));
        // 타입 참조/메서드 호출은 SimpleEvaluationContext 에서 차단됨 → 예외 → false 폴백
        assertFalse(evaluator.evaluateBoolean("T(java.lang.System).exit(0) == null", ctx));
        assertFalse(evaluator.evaluateBoolean("''.getClass().getName() == 'x'", ctx));
    }
}
