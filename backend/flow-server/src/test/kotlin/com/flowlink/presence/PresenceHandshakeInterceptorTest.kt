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

    private fun jwt(username: String? = "alice"): Jwt {
        val b = Jwt.withTokenValue("tok").header("alg", "none")
            .subject("sub-1").issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(60))
        if (username != null) b.claim("preferred_username", username)
        return b.build()
    }

    @Test
    fun `dev 모드(디코더 없음) - flowId 와 이름을 attrs 에 채우고 허용`() {
        val i = PresenceHandshakeInterceptor(null) { _, _ -> true }
        val (ok, attrs, _) = run(i, "flowId=$flowId&name=%EA%B2%8C%EC%8A%A4%ED%8A%B8")
        assertTrue(ok)
        assertEquals(flowId.toString(), attrs["flowId"])
        assertEquals("게스트", attrs["name"])
    }

    @Test
    fun `flowId 누락 또는 UUID 아님 - 거절`() {
        val i = PresenceHandshakeInterceptor(null) { _, _ -> true }
        assertFalse(run(i, "name=x").first)
        assertFalse(run(i, "flowId=not-a-uuid").first)
    }

    @Test
    fun `토큰 - 유효 토큰 + 접근 가능한 flow 는 허용, 이름은 preferred_username`() {
        val dec = JwtDecoder { jwt() }
        var checked: Pair<UUID, String>? = null
        val i = PresenceHandshakeInterceptor(dec) { id, u -> checked = id to u; true }
        val (ok, attrs, _) = run(i, "flowId=$flowId&token=tok&name=ignored")
        assertTrue(ok)
        assertEquals("alice", attrs["name"])       // 쿼리 name 무시, JWT 사용자명
        // 접근 판정 콜백은 이제 **사용자명**(소문자)을 받는다 — 워크스페이스 롤 게이트의 근거
        assertEquals(flowId to "alice", checked)
    }

    @Test
    fun `토큰 - 다른 테넌트의 flow 는 403 거절`() {
        val dec = JwtDecoder { jwt() }
        val i = PresenceHandshakeInterceptor(dec) { _, _ -> false }
        val (ok, _, res) = run(i, "flowId=$flowId&token=tok")
        assertFalse(ok); assertEquals(HttpStatus.FORBIDDEN.value(), res.status)
    }

    @Test
    fun `게스트 허용 - 토큰 없으면 dev 방식(쿼리 name)으로 허용`() {
        val dec = JwtDecoder { jwt() }
        val i = PresenceHandshakeInterceptor(dec) { _, _ -> true }
        val (ok, attrs, _) = run(i, "flowId=$flowId&name=%EA%B2%8C%EC%8A%A4%ED%8A%B8-ab12")
        assertTrue(ok)
        assertEquals("게스트-ab12", attrs["name"])
    }

    @Test
    fun `게스트 허용 - name 파라미터 없음 또는 빈값이면 기본값 게스트`() {
        val dec = JwtDecoder { jwt() }
        val i = PresenceHandshakeInterceptor(dec) { _, _ -> true }
        val (ok1, attrs1, _) = run(i, "flowId=$flowId")
        assertTrue(ok1)
        assertEquals("게스트", attrs1["name"])
        val (ok2, attrs2, _) = run(i, "flowId=$flowId&name=")
        assertTrue(ok2)
        assertEquals("게스트", attrs2["name"])
    }

    @Test
    fun `게스트 허용 - 무효 토큰은 여전히 401(조용한 다운그레이드 금지)`() {
        val bad = JwtDecoder { throw JwtException("bad") }
        val i = PresenceHandshakeInterceptor(bad) { _, _ -> true }
        val (ok, _, res) = run(i, "flowId=$flowId&token=zzz")
        assertFalse(ok)
        assertEquals(HttpStatus.UNAUTHORIZED.value(), res.status)
    }

    @Test
    fun `게스트 허용 - 유효 토큰은 JWT 사용자명 사용`() {
        val dec = JwtDecoder { jwt() }
        val i = PresenceHandshakeInterceptor(dec) { _, _ -> true }
        val (ok, attrs, _) = run(i, "flowId=$flowId&token=tok&name=ignored")
        assertTrue(ok)
        assertEquals("alice", attrs["name"])
    }
}
