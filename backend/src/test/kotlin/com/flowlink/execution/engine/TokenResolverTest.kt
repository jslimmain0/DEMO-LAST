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

    /** JSON 안의 JSON — 중첩 경로({{ user.name }}·{{ items[0].id }})로 꺼낸다. */
    @Test
    fun nestedPathTokens() {
        val ctx = ExecutionContext()
        ctx.putOutput("n1", mapOf(
            "user" to mapOf("name" to "kim", "addr" to mapOf("city" to "seoul")),
            "items" to listOf(mapOf("id" to "A-1", "qty" to 2L), mapOf("id" to "B-2")),
            "tags" to listOf("vip", "kr"),
        ))
        // 점 경로 — 2단·3단
        assertEquals("kim", resolver.resolveTokens("{{ user.name@n1 }}", ctx))
        assertEquals("seoul", resolver.resolveTokens("{{ user.addr.city@n1 }}", ctx))
        // 배열 인덱스 — [0] 과 .0 둘 다
        assertEquals("A-1", resolver.resolveTokens("{{ items[0].id@n1 }}", ctx))
        assertEquals("B-2", resolver.resolveTokens("{{ items.1.id@n1 }}", ctx))
        assertEquals("vip", resolver.resolveTokens("{{ tags[0]@n1 }}", ctx))
        // bare 토큰(가장 가까운 상위)도 경로 지원
        assertEquals("kim", resolver.resolveTokens("{{ user.name }}", ctx))
        // 전체-토큰 리터럴은 원형 보존 — 조건식({{ items[0].qty@n1 }} == 2)이 숫자 비교로 동작
        assertEquals(2L, resolver.resolveLiteral("{{ items[0].qty@n1 }}", ctx))
        assertEquals(mapOf("city" to "seoul"), resolver.resolveLiteral("{{ user.addr@n1 }}", ctx))
        // 바인딩(picker)도 동일 경로
        assertEquals("kim", resolver.resolveBinding(Binding(null, null, "user.name", "n1", null), ctx))
    }

    /** 평평한 실키 우선 — 응답에 "a.b" 라는 키가 문자 그대로 있으면 경로 해석보다 우선(호환). */
    @Test
    fun flatKeyWithDotWinsOverPath() {
        val ctx = ExecutionContext()
        ctx.putOutput("n1", mapOf("a.b" to "flat", "a" to mapOf("b" to "nested")))
        assertEquals("flat", resolver.resolveTokens("{{ a.b@n1 }}", ctx))
    }

    /** 이중 인코딩 — 값이 JSON "문자열"이어도 경로가 남았으면 파싱해 내려간다(레거시 json-in-json). */
    @Test
    fun jsonStringInsideJson() {
        val ctx = ExecutionContext()
        ctx.putOutput("n1", mapOf(
            "data" to """{"inner":{"code":"0000","amt":500},"list":[{"id":"L1"}]}""",
            "plain" to "그냥 문자열",
        ))
        assertEquals("0000", resolver.resolveTokens("{{ data.inner.code@n1 }}", ctx))
        assertEquals(500, resolver.resolveLiteral("{{ data.inner.amt@n1 }}", ctx)) // Jackson 정수 파싱=Int
        assertEquals("L1", resolver.resolveTokens("{{ data.list[0].id@n1 }}", ctx))
        // JSON 이 아닌 문자열에 경로를 더 파고들면 부재(빈 치환)
        assertEquals("x=", resolver.resolveTokens("x={{ plain.deep@n1 }}", ctx))
        // 문자열 값 자체는 그대로(경로 없이)
        assertEquals("그냥 문자열", resolver.resolveTokens("{{ plain@n1 }}", ctx))
    }

    /** 부재 경로 — 빈 문자열 치환(중간 타입 불일치·범위 밖 인덱스 포함), bare 는 상위 노드 계속 탐색. */
    @Test
    fun missingNestedPathFallsThrough() {
        val ctx = ExecutionContext()
        ctx.putOutput("n1", mapOf("user" to mapOf("name" to "kim")))
        ctx.putOutput("n2", mapOf("user" to "문자열")) // 더 최근이지만 user.name 경로 없음
        assertEquals("x=", resolver.resolveTokens("x={{ user.nope@n1 }}", ctx))
        assertEquals("x=", resolver.resolveTokens("x={{ user.name.deep@n1 }}", ctx))
        assertEquals("x=", resolver.resolveTokens("x={{ user[5]@n1 }}", ctx))
        // bare — n2(문자열)에선 부재 → n1 로 폴스루
        assertEquals("kim", resolver.resolveTokens("{{ user.name }}", ctx))
    }
}
