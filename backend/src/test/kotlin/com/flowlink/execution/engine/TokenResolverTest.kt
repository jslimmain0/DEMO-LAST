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

    /** URL(base+path) — 리터럴 + 이전 노드 토큰 + env 토큰 + 다중 토큰 혼합이 모두 문자열 치환된다. */
    @Test
    fun urlBasePathMixedTokens() {
        val ctx = ExecutionContext()
        ctx.putOutput("s1", mapOf("ver" to "v2", "oid" to 12345))
        ctx.putOutput("env", mapOf("host" to "https://api.example.com")) // {{ 키@env }} 는 env 스코프 시드

        // baseUrl: env 토큰 + 리터럴
        assertEquals("https://api.example.com/api", resolver.resolveTokens("{{ host@env }}/api", ctx))
        // path: 리터럴 + 이전 노드 토큰 2개 이상 혼합
        assertEquals("/orders/v2/12345", resolver.resolveTokens("/orders/{{ ver@s1 }}/{{ oid@s1 }}", ctx))
        // 하드코딩 + 토큰이 한 세그먼트에 붙어도 치환
        assertEquals("https://api.example.com/v2-x", resolver.resolveTokens("{{ host@env }}/{{ ver@s1 }}-x", ctx))
        // build() 가 이어붙이는 base+path 최종 결과
        val url = resolver.resolveTokens("{{ host@env }}/api", ctx) + resolver.resolveTokens("/orders/{{ ver@s1 }}/{{ oid@s1 }}", ctx)
        assertEquals("https://api.example.com/api/orders/v2/12345", url)
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

    /** 한글 응답 키·kebab/snake 노드 id 토큰 — bound→토큰 이관 호환(문법 확장 회귀 방지). */
    @Test
    fun hangulKeyAndKebabSourceId() {
        val ctx = ExecutionContext()
        ctx.putOutput("http-1", mapOf("승인코드" to "0000", "amount" to 500))
        assertEquals("0000", resolver.resolveTokens("{{ 승인코드@http-1 }}", ctx))
        assertEquals("500", resolver.resolveTokens("{{ amount@http-1 }}", ctx))
        assertEquals("0000", resolver.resolveLiteral("{{ 승인코드@http-1 }}", ctx))
    }

    /** 리터럴이 정확히 토큰 하나면 원형(숫자/불리언/객체) 보존 — 구 bound 의 토큰 문자열 이관과 의미 동일. */
    @Test
    fun wholeTokenLiteralPreservesType() {
        val ctx = ExecutionContext()
        ctx.putOutput("n1", mapOf("cnt" to 30L, "ok" to true, "obj" to mapOf("a" to 1)))
        assertEquals(30L, resolver.resolveLiteral("{{ cnt@n1 }}", ctx))
        assertEquals(true, resolver.resolveLiteral(" {{ ok@n1 }} ", ctx)) // 앞뒤 공백 허용
        assertEquals(mapOf("a" to 1), resolver.resolveLiteral("{{ obj@n1 }}", ctx))
        // 텍스트가 섞이면 문자열 치환
        assertEquals("총 30건", resolver.resolveLiteral("총 {{ cnt@n1 }}건", ctx))
        // 필드 경로도 동일 규칙
        val f = NodeField("f1", "qty", "{{ cnt@n1 }}", null, null)
        assertEquals(30L, resolver.fieldValue(f, ctx))
    }
}
