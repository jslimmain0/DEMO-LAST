package com.flowlink.presence

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketExtension
import org.springframework.web.socket.WebSocketMessage
import org.springframework.web.socket.WebSocketSession
import java.net.InetSocketAddress
import java.net.URI

/** 전송 프레임을 기록하는 가짜 세션 — 네트워크 없이 릴레이 로직을 검증한다. failSend=true 면 전송이 던진다. */
class FakeSession(private val id: String, flowId: String, name: String, var failSend: Boolean = false) : WebSocketSession {
    val sent = mutableListOf<String>()
    private val attrs = mutableMapOf<String, Any>("flowId" to flowId, "name" to name)
    private var open = true
    override fun getId() = id
    override fun getUri(): URI? = URI.create("ws://test/ws/presence")
    override fun getHandshakeHeaders() = org.springframework.http.HttpHeaders()
    override fun getAttributes() = attrs
    override fun getPrincipal(): java.security.Principal? = null
    override fun getLocalAddress(): InetSocketAddress? = null
    override fun getRemoteAddress(): InetSocketAddress? = null
    override fun getAcceptedProtocol(): String? = null
    override fun setTextMessageSizeLimit(limit: Int) {}
    override fun getTextMessageSizeLimit() = 8192
    override fun setBinaryMessageSizeLimit(limit: Int) {}
    override fun getBinaryMessageSizeLimit() = 8192
    override fun getExtensions(): List<WebSocketExtension> = emptyList()
    override fun sendMessage(message: WebSocketMessage<*>) {
        if (failSend) throw java.io.IOException("소켓 끊김")
        sent.add((message as TextMessage).payload)
    }
    override fun isOpen() = open
    override fun close() { open = false }
    override fun close(status: CloseStatus) { open = false }
}

class PresenceHandlerTest {
    private val mapper = ObjectMapper()
    private val handler = PresenceHandler(mapper)
    private fun parse(s: String): JsonNode = mapper.readTree(s)
    private fun last(s: FakeSession): JsonNode = parse(s.sent.last())

    @Test
    fun `두번째 입장자의 hello 에 첫 참여자 스냅샷이 실린다`() {
        val a = FakeSession("A", "f1", "alice"); val b = FakeSession("B", "f1", "bob")
        handler.afterConnectionEstablished(a)
        handler.afterConnectionEstablished(b)
        val hello = parse(b.sent.first())
        assertEquals("hello", hello["t"].asText())
        assertEquals("B", hello["id"].asText())
        assertEquals(1, hello["peers"].size())
        assertEquals("alice", hello["peers"][0]["name"].asText())
        // A 는 join 브로드캐스트를 받는다
        val join = last(a)
        assertEquals("join", join["t"].asText())
        assertEquals("bob", join["peer"]["name"].asText())
    }

    @Test
    fun `커서는 보낸 사람 제외 + id 부착으로 중계된다`() {
        val a = FakeSession("A", "f1", "alice"); val b = FakeSession("B", "f1", "bob")
        handler.afterConnectionEstablished(a); handler.afterConnectionEstablished(b)
        val aSentBefore = a.sent.size; val bSentBefore = b.sent.size
        handler.handleMessage(b, TextMessage("""{"t":"cursor","x":10.5,"y":20}"""))
        assertEquals(bSentBefore, b.sent.size)          // 본인에겐 미전송
        val relayed = last(a)
        assertEquals("cursor", relayed["t"].asText())
        assertEquals("B", relayed["id"].asText())
        assertEquals(10.5, relayed["x"].asDouble(), 0.001)
        assertTrue(a.sent.size == aSentBefore + 1)
    }

    @Test
    fun `editing 상태가 늦게 온 참여자의 hello 스냅샷에 실린다`() {
        val a = FakeSession("A", "f1", "alice")
        handler.afterConnectionEstablished(a)
        handler.handleMessage(a, TextMessage("""{"t":"editing","nodeId":"n7"}"""))
        handler.handleMessage(a, TextMessage("""{"t":"cursor","x":1,"y":2}"""))
        val c = FakeSession("C", "f1", "carol")
        handler.afterConnectionEstablished(c)
        val peer = parse(c.sent.first())["peers"][0]
        assertEquals("n7", peer["editing"].asText())
        assertEquals(1.0, peer["cursor"]["x"].asDouble(), 0.001)
    }

    @Test
    fun `다른 방(flowId)은 격리된다`() {
        val a = FakeSession("A", "f1", "alice"); val x = FakeSession("X", "f2", "xavier")
        handler.afterConnectionEstablished(a)
        val aSent = a.sent.size
        handler.afterConnectionEstablished(x)
        handler.handleMessage(x, TextMessage("""{"t":"cursor","x":1,"y":1}"""))
        assertEquals(aSent, a.sent.size)               // f2 이벤트가 f1 에 안 옴
    }

    @Test
    fun `퇴장하면 leave 가 브로드캐스트되고 방에서 사라진다`() {
        val a = FakeSession("A", "f1", "alice"); val b = FakeSession("B", "f1", "bob")
        handler.afterConnectionEstablished(a); handler.afterConnectionEstablished(b)
        handler.afterConnectionClosed(b, CloseStatus.NORMAL)
        val leave = last(a)
        assertEquals("leave", leave["t"].asText())
        assertEquals("B", leave["id"].asText())
        val c = FakeSession("C", "f1", "carol")
        handler.afterConnectionEstablished(c)
        assertEquals(1, parse(c.sent.first())["peers"].size())   // alice 만 남음
    }

    @Test
    fun `전송 실패로 퇴출된 참여자도 leave 가 브로드캐스트된다(유령 방지)`() {
        val a = FakeSession("A", "f1", "alice"); val b = FakeSession("B", "f1", "bob")
        handler.afterConnectionEstablished(a); handler.afterConnectionEstablished(b)
        b.failSend = true // 이제 B 로의 전송은 던진다 → 다음 브로드캐스트에서 퇴출
        // A 가 커서를 보내면 B 로 중계 시도 → 실패 → B 퇴출 + A 에게 leave
        handler.handleMessage(a, TextMessage("""{"t":"cursor","x":1,"y":1}"""))
        val leave = last(a)
        assertEquals("leave", leave["t"].asText())
        assertEquals("B", leave["id"].asText())
        // B 가 방에서 빠졌는지 — 새 입장자의 스냅샷에 A 만 남는다
        val c = FakeSession("C", "f1", "carol")
        handler.afterConnectionEstablished(c)
        assertEquals(1, parse(c.sent.first())["peers"].size())
    }

    @Test
    fun `방 참여자들은 서로 다른 색을 받는다`() {
        val a = FakeSession("A", "f1", "alice"); val b = FakeSession("B", "f1", "bob")
        handler.afterConnectionEstablished(a); handler.afterConnectionEstablished(b)
        val join = last(a)
        val colorB = join["peer"]["color"].asText()
        // A 의 색(B 의 hello 스냅샷에서)과 달라야 한다
        val colorA = parse(b.sent.first())["peers"][0]["color"].asText()
        assertTrue(colorA != colorB, "색 충돌: $colorA")
    }

    @Test
    fun `saved 는 name 을 붙여 중계하고, 잘못된 JSON 과 미지의 타입은 무시한다`() {
        val a = FakeSession("A", "f1", "alice"); val b = FakeSession("B", "f1", "bob")
        handler.afterConnectionEstablished(a); handler.afterConnectionEstablished(b)
        handler.handleMessage(b, TextMessage("""{"t":"saved"}"""))
        val saved = last(a)
        assertEquals("saved", saved["t"].asText())
        assertEquals("bob", saved["name"].asText())
        val aSent = a.sent.size
        handler.handleMessage(b, TextMessage("not-json{{"))
        handler.handleMessage(b, TextMessage("""{"t":"hack"}"""))
        assertEquals(aSent, a.sent.size)
    }
}
