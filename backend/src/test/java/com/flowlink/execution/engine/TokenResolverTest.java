package com.flowlink.execution.engine;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.flowlink.common.json.JsonService;
import com.flowlink.core.graph.Binding;
import com.flowlink.core.graph.NodeField;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** 바인딩/토큰 해석이 프로토타입 의미와 일치하는지 검증. */
class TokenResolverTest {

    private final JsonService json = new JsonService(new ObjectMapper());
    private final TokenResolver resolver = new TokenResolver(json);

    @Test
    void explicitSourceToken() {
        ExecutionContext ctx = new ExecutionContext();
        ctx.putOutput("n1", Map.of("name", "kim", "id", 7));
        assertEquals("kim", resolver.resolveTokens("{{ name@n1 }}", ctx));
        assertEquals("user-7", resolver.resolveTokens("user-{{ id@n1 }}", ctx));
    }

    @Test
    void bareTokenUsesNearestUpstream() {
        ExecutionContext ctx = new ExecutionContext();
        ctx.putOutput("n1", Map.of("token", "AAA"));
        ctx.putOutput("n2", Map.of("token", "BBB")); // 더 최근 → 우선
        assertEquals("BBB", resolver.resolveTokens("{{ token }}", ctx));
    }

    @Test
    void unresolvedTokenBecomesEmpty() {
        ExecutionContext ctx = new ExecutionContext();
        assertEquals("x=", resolver.resolveTokens("x={{ nope@nX }}", ctx));
    }

    @Test
    void boundFieldResolvesObjectValue() {
        ExecutionContext ctx = new ExecutionContext();
        ctx.putOutput("n1", Map.of("id", 42));
        NodeField f = new NodeField("f1", "userId", null,
                new Binding("사용자조회", "auth", "id", "n1", null));
        assertEquals(42, resolver.fieldValue(f, ctx));
    }

    @Test
    void requestScopeBinding() {
        ExecutionContext ctx = new ExecutionContext();
        ctx.putRequest("n1", Map.of("amount", "5000"));
        NodeField f = new NodeField("f1", "amt", null,
                new Binding("결제", "card", "amount", "n1", "req"));
        assertEquals("5000", resolver.fieldValue(f, ctx));
    }
}
