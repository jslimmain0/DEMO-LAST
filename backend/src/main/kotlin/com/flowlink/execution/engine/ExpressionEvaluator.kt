package com.flowlink.execution.engine

import org.slf4j.Logger
import org.slf4j.LoggerFactory
import org.springframework.expression.spel.standard.SpelExpressionParser
import org.springframework.expression.spel.support.SimpleEvaluationContext
import org.springframework.stereotype.Component
import java.util.regex.Matcher

/**
 * IF 노드 조건의 <b>안전</b> 평가기.
 *
 * <p>프로토타입의 {@code new Function('return ('+expr+')')} (임의 JS 실행, 심각한 보안 취약)을 대체한다.
 * 동작 방식:
 * <ol>
 *   <li>{@code {{ token }}} 들을 SpEL 변수 {@code #__tN} 으로 치환하고 해석된 <b>값 객체</b>를 바인딩.
 *       (값을 문자열로 끼워넣지 않으므로 표현식 인젝션이 불가능)</li>
 *   <li>{@link SimpleEvaluationContext#forReadOnlyDataBinding()} 로 평가 — 타입 참조/생성자/빈 참조/
 *       임의 메서드 호출이 모두 차단된 읽기 전용 컨텍스트.</li>
 * </ol>
 *
 * <p>지원: 비교({@code == != < > <= >=}), 논리({@code && || !}, {@code and/or/not}), null 비교, 산술.
 * 평가 실패 시 프로토타입과 동일하게 {@code false} 로 폴백한다.
 */
@Component
class ExpressionEvaluator(private val tokens: TokenResolver) {

    private val parser = SpelExpressionParser()

    fun evaluateBoolean(condition: String?, ctx: ExecutionContext): Boolean {
        if (condition == null || condition.isBlank()) {
            return true // 조건 없으면 통과 (프로토타입 'true' 기본값과 동일)
        }
        if (condition.length > MAX_CONDITION_LENGTH) {
            log.warn("IF 조건이 길이 상한({})을 초과해 false 처리: len={}", MAX_CONDITION_LENGTH, condition.length)
            return false
        }
        val spelCtx = SimpleEvaluationContext.forReadOnlyDataBinding().build()

        val m = TokenResolver.tokenPattern().matcher(condition)
        val rewritten = StringBuilder()
        var idx = 0
        while (m.find()) {
            if (idx >= MAX_TOKENS) {
                log.warn("IF 조건의 토큰 수가 상한({})을 초과해 false 처리", MAX_TOKENS)
                return false
            }
            val key = m.group(1)
            val req = m.group(2) != null
            val srcId = m.group(3)
            val value = tokens.resolveTokenObject(key, req, srcId, ctx)
            val varName = "__t" + idx++
            spelCtx.setVariable(varName, value)
            m.appendReplacement(rewritten, Matcher.quoteReplacement("#$varName"))
        }
        m.appendTail(rewritten)

        return try {
            val expr = parser.parseExpression(rewritten.toString())
            val result = expr.getValue(spelCtx, Boolean::class.javaObjectType)
            result == true
        } catch (e: Exception) {
            false
        }
    }

    companion object {
        private val log: Logger = LoggerFactory.getLogger(ExpressionEvaluator::class.java)

        /**
         * 종료성(termination) 가드. SpEL 은 루프가 없어 평가 비용이 AST 크기에 비례하므로,
         * 표현식 길이·토큰 수 상한을 두면 평가 시간이 사실상 상한된다(CPU DoS 방어).
         * (Phase 0.5: CEL cost-limit 또는 별도 스레드 하드 타임아웃으로 강화 예정)
         */
        private const val MAX_CONDITION_LENGTH = 2000
        private const val MAX_TOKENS = 50
    }
}
