package com.flowlink.presence

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.http.server.ServletServerHttpRequest
import org.springframework.http.server.ServletServerHttpResponse
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.security.oauth2.jwt.JwtException
import java.time.Instant
import java.util.UUID

class PresenceHandshakeInterceptorTest {
    private val flowId = UUID.randomUUID()
    private val handlerStub = org.springframework.web.socket.handler.TextWebSocketHandler()

    private fun run(interceptor: PresenceHandshakeInterceptor, query: String):
        Triple<Boolean, MutableMap<String, Any>, MockHttpServletResponse> {
        val req = MockHttpServletRequest("GET", "/ws/presence")
        req.queryString = query
        val attrs = mutableMapOf<String, Any>()
        val res = MockHttpServletResponse()
        val ok = interceptor.beforeHandshake(
            ServletServerHttpRequest(req), ServletServerHttpResponse(res), handlerStub, attrs)
        return Triple(ok, attrs, res)
    }

    private fun jwt(tenant: String?, username: String? = "alice"): Jwt {
        val b = Jwt.withTokenValue("tok").header("alg", "none")
            .subject("sub-1").issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(60))
        if (tenant != null) b.claim("tenant", tenant)
        if (username != null) b.claim("preferred_username", username)
        return b.build()
    }

    @Test
    fun `dev 모드(디코더 없음) - flowId 와 이름을 attrs 에 채우고 허용`() {
        val i = PresenceHandshakeInterceptor(null, "tenant") { _, _ -> true }
        val (ok, attrs, _) = run(i, "flowId=$flowId&name=%EA%B2%8C%EC%8A%A4%ED%8A%B8")
        assertTrue(ok)
        assertEquals(flowId.toString(), attrs["flowId"])
        assertEquals("게스트", attrs["name"])
    }

    @Test
    fun `flowId 누락 또는 UUID 아님 - 거절`() {
        val i = PresenceHandshakeInterceptor(null, "tenant") { _, _ -> true }
        assertFalse(run(i, "name=x").first)
        assertFalse(run(i, "flowId=not-a-uuid").first)
    }

    @Test
    fun `OIDC - 토큰 없음 또는 무효 토큰은 401 거절`() {
        val bad = JwtDecoder { throw JwtException("bad") }
        val i = PresenceHandshakeInterceptor(bad, "tenant") { _, _ -> true }
        val (ok1, _, res1) = run(i, "flowId=$flowId")
        assertFalse(ok1); assertEquals(HttpStatus.UNAUTHORIZED.value(), res1.status)
        val (ok2, _, res2) = run(i, "flowId=$flowId&token=zzz")
        assertFalse(ok2); assertEquals(HttpStatus.UNAUTHORIZED.value(), res2.status)
    }

    @Test
    fun `OIDC - 유효 토큰 + 접근 가능한 flow 는 허용, 이름은 preferred_username`() {
        val dec = JwtDecoder { jwt("team-a") }
        var checked: Pair<UUID, String>? = null
        val i = PresenceHandshakeInterceptor(dec, "tenant") { id, t -> checked = id to t; true }
        val (ok, attrs, _) = run(i, "flowId=$flowId&token=tok&name=ignored")
        assertTrue(ok)
        assertEquals("alice", attrs["name"])       // 쿼리 name 무시, JWT 사용자명
        assertEquals(flowId to "team-a", checked)
    }

    @Test
    fun `OIDC - 다른 테넌트의 flow 는 403 거절`() {
        val dec = JwtDecoder { jwt("team-b") }
        val i = PresenceHandshakeInterceptor(dec, "tenant") { _, _ -> false }
        val (ok, _, res) = run(i, "flowId=$flowId&token=tok")
        assertFalse(ok); assertEquals(HttpStatus.FORBIDDEN.value(), res.status)
    }
}
