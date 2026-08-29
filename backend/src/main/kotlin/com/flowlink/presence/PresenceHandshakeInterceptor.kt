package com.flowlink.presence

import org.springframework.http.HttpStatus
import org.springframework.http.server.ServerHttpRequest
import org.springframework.http.server.ServerHttpResponse
import org.springframework.http.server.ServletServerHttpResponse
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.security.oauth2.jwt.JwtException
import org.springframework.web.socket.WebSocketHandler
import org.springframework.web.socket.server.HandshakeInterceptor
import org.springframework.web.util.UriComponentsBuilder
import java.util.UUID

/**
 * presence 핸드셰이크 검증.
 * - dev 모드(decoder=null): 무인증 — flowId 만 UUID 검사, 이름은 쿼리 name(40자 클램프).
 * - OIDC 모드: 브라우저 WebSocket 은 Authorization 헤더를 못 실으므로 쿼리 `?token=` JWT 를 검증하고
 *   flow 가 토큰 테넌트 소유인지 확인(교차 테넌트 훔쳐보기 차단). 이름은 JWT preferred_username.
 * - github 게스트 모드(guestAllowed=true): 토큰 없는 접속을 dev 방식(쿼리 name)으로 허용 — 앱이 게스트 개방이므로.
 *   토큰이 있으면 기존대로 검증(무효 토큰은 401 — 게스트로 조용히 다운그레이드하지 않는다).
 */
class PresenceHandshakeInterceptor(
    private val decoder: JwtDecoder?,
    private val tenantClaim: String,
    private val guestAllowed: Boolean = false,
    private val flowAccessCheck: (UUID, String) -> Boolean,
) : HandshakeInterceptor {

    override fun beforeHandshake(request: ServerHttpRequest, response: ServerHttpResponse,
                                 wsHandler: WebSocketHandler, attributes: MutableMap<String, Any>): Boolean {
        val params = UriComponentsBuilder.fromUri(request.uri).build().queryParams
        val flowId = params.getFirst("flowId") ?: return refuse(response, HttpStatus.BAD_REQUEST)
        val uuid = try { UUID.fromString(flowId) } catch (e: IllegalArgumentException) {
            return refuse(response, HttpStatus.BAD_REQUEST)
        }
        if (decoder == null) {
            attributes["flowId"] = flowId
            attributes["name"] = decoded(params.getFirst("name")).ifBlank { "익명" }.take(40)
            return true
        }
        val token = params.getFirst("token")
        if (token == null && guestAllowed) {
            // github 게스트 모드 — 앱 자체가 게스트 개방이므로 WS 도 dev 방식(쿼리 name)으로 허용.
            // 단 팀/개인 워크스페이스 flow 의 방은 게스트 입장 거부(누가 어느 노드를 편집 중인지 노출 방지).
            if (!flowAccessCheck(uuid, "guest")) return refuse(response, HttpStatus.FORBIDDEN)
            attributes["flowId"] = flowId
            attributes["name"] = decoded(params.getFirst("name")).ifBlank { "게스트" }.take(40)
            return true
        }
        if (token == null) return refuse(response, HttpStatus.UNAUTHORIZED)
        val jwt = try { decoder.decode(token) } catch (e: JwtException) {
            return refuse(response, HttpStatus.UNAUTHORIZED)
        }
        val username = (jwt.getClaimAsString("preferred_username") ?: jwt.subject ?: "").lowercase()
        // 워크스페이스 롤 게이트 — flow 존재만 보던 검사를 롤 판정으로 교체(비멤버의 팀 방 입장 차단).
        if (!flowAccessCheck(uuid, username)) return refuse(response, HttpStatus.FORBIDDEN)
        attributes["flowId"] = flowId
        attributes["name"] = (jwt.getClaimAsString("preferred_username") ?: jwt.subject).take(40)
        return true
    }

    override fun afterHandshake(request: ServerHttpRequest, response: ServerHttpResponse,
                                wsHandler: WebSocketHandler, exception: Exception?) { /* 없음 */ }

    /** 쿼리 값은 컨테이너에 따라 raw 로 올 수 있어 percent 디코딩(실패 시 원문). */
    private fun decoded(v: String?): String =
        try { java.net.URLDecoder.decode(v ?: "", Charsets.UTF_8) } catch (e: IllegalArgumentException) { v ?: "" }

    private fun refuse(response: ServerHttpResponse, status: HttpStatus): Boolean {
        (response as? ServletServerHttpResponse)?.servletResponse?.status = status.value()
        return false
    }
}
