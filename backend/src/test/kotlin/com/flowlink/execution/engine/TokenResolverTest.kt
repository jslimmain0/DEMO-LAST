package com.flowlink.execution.engine

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.Binding
import com.flowlink.core.graph.NodeField
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** 바인딩/토큰 해석이 프로토타입 의미와 일치하는지 검증. */
class TokenResolverTest {

    private val json = JsonService(ObjectMapper())
    private val resolver = TokenResolver(json)

    @Test
    fun explicitSourceToken() {
        val ctx = ExecutionContext()
        ctx.putOutput("n1", mapOf("name" to "kim", "id" to 7))
        assertEquals("kim", resolver.resolveTokens("{{ name@n1 }}", ctx))
        assertEquals("user-7", resolver.resolveTokens("user-{{ id@n1 }}", ctx))
    }

    @Test
    fun bareTokenUsesNearestUpstream() {
        val ctx = ExecutionContext()
        ctx.putOutput("n1", mapOf("token" to "AAA"))
        ctx.putOutput("n2", mapOf("token" to "BBB")) // 더 최근 → 우선
        assertEquals("BBB", resolver.resolveTokens("{{ token }}", ctx))
    }

    @Test
    fun unresolvedTokenBecomesEmpty() {
        val ctx = ExecutionContext()
        assertEquals("x=", resolver.resolveTokens("x={{ nope@nX }}", ctx))
    }

    @Test
    fun boundFieldResolvesObjectValue() {
        val ctx = ExecutionContext()
        ctx.putOutput("n1", mapOf("id" to 42))
        val f = NodeField(
            "f1", "userId", null,
            Binding("사용자조회", "auth", "id", "n1", null), null
        )
        assertEquals(42, resolver.fieldValue(f, ctx))
    }

    @Test
    fun requestScopeBinding() {
        val ctx = ExecutionContext()
        ctx.putRequest("n1", mapOf("amount" to "5000"))
        val f = NodeField(
            "f1", "amt", null,
            Binding("결제", "card", "amount", "n1", "req"), null
        )
        assertEquals("5000", resolver.fieldValue(f, ctx))
    }
}
