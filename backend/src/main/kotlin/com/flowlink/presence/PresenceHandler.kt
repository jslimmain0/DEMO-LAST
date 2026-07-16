package com.flowlink.presence

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator
import org.springframework.web.socket.handler.TextWebSocketHandler
import java.util.concurrent.ConcurrentHashMap

/**
 * presence 릴레이 — 방(flowId)별로 커서·편집중·저장 이벤트를 다른 참여자에게 중계한다.
 * 그래프 데이터는 만지지 않는다(공동 편집 아님). 참여자의 최신 커서/편집중만
 * 방 스냅샷(hello)용으로 인메모리 보관하며, 서버 재시작 시 소실돼도 무방(클라이언트가 재접속·재전송).
 */
@Component
class PresenceHandler(private val mapper: ObjectMapper) : TextWebSocketHandler() {

    /** 방 참여자 한 명 — session 은 동시 전송 안전 데코레이터로 감싼 것. */
    class Peer(val session: WebSocketSession, val name: String, val color: String) {
        @Volatile var cursor: JsonNode? = null
        @Volatile var editing: String? = null
    }

    private val rooms = ConcurrentHashMap<String, ConcurrentHashMap<String, Peer>>()

    override fun afterConnectionEstablished(raw: WebSocketSession) {
        val flowId = raw.attributes["flowId"] as? String
        if (flowId == null) { raw.close(CloseStatus.BAD_DATA); return }
        val name = (raw.attributes["name"] as? String) ?: "익명"
        // 표준 WebSocketSession 은 동시 sendMessage 가 미정의 — 데코레이터로 직렬화(버퍼 64KB·2초 제한)
        val session = ConcurrentWebSocketSessionDecorator(raw, 2000, 64 * 1024)
        val room = rooms.computeIfAbsent(flowId) { ConcurrentHashMap() }
        val peer = Peer(session, name, COLORS[room.size % COLORS.size])
        room[session.id] = peer
        val hello = mapper.createObjectNode()
        hello.put("t", "hello"); hello.put("id", session.id)
        val arr = hello.putArray("peers")
        room.forEach { (id, p) -> if (id != session.id) arr.add(peerJson(id, p)) }
        send(flowId, session.id, peer, hello)
        val join = mapper.createObjectNode()
        join.put("t", "join"); join.set<ObjectNode>("peer", peerJson(session.id, peer))
        broadcast(flowId, session.id, join)
        log.debug("presence join flow={} id={} name={} ({}명)", flowId, session.id, name, room.size)
    }

    override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
        val flowId = session.attributes["flowId"] as? String ?: return
        val room = rooms[flowId] ?: return
        val peer = room[session.id] ?: return
        val msg = try { mapper.readTree(message.payload) } catch (e: Exception) { return }
        val out = mapper.createObjectNode()
        out.put("id", session.id)
        when (msg.path("t").asText()) {
            "cursor" -> {
                peer.cursor = if (msg.path("x").isNumber) msg else null
                out.put("t", "cursor"); out.set<JsonNode>("x", msg.path("x")); out.set<JsonNode>("y", msg.path("y"))
            }
            "editing" -> {
                peer.editing = msg.path("nodeId").takeIf { it.isTextual }?.asText()
                out.put("t", "editing")
                if (peer.editing != null) out.put("nodeId", peer.editing) else out.putNull("nodeId")
            }
            "saved" -> { out.put("t", "saved"); out.put("name", peer.name) }
            else -> return   // 미지의 타입은 무시(전방 호환)
        }
        broadcast(flowId, session.id, out)
    }

    override fun afterConnectionClosed(session: WebSocketSession, status: CloseStatus) {
        val flowId = session.attributes["flowId"] as? String ?: return
        val room = rooms[flowId] ?: return
        if (room.remove(session.id) == null) return
        if (room.isEmpty()) rooms.remove(flowId, room)
        val leave = mapper.createObjectNode()
        leave.put("t", "leave"); leave.put("id", session.id)
        broadcast(flowId, session.id, leave)
    }

    private fun peerJson(id: String, p: Peer): ObjectNode {
        val n = mapper.createObjectNode()
        n.put("id", id); n.put("name", p.name); n.put("color", p.color)
        val cur = p.cursor
        if (cur != null) {
            val c = n.putObject("cursor")
            c.set<JsonNode>("x", cur.path("x")); c.set<JsonNode>("y", cur.path("y"))
        } else n.putNull("cursor")
        val ed = p.editing
        if (ed != null) n.put("editing", ed) else n.putNull("editing")
        return n
    }

    private fun broadcast(flowId: String, senderId: String, node: ObjectNode) {
        val room = rooms[flowId] ?: return
        room.forEach { (id, p) -> if (id != senderId) send(flowId, id, p, node) }
    }

    /** 전송 실패(끊긴 소켓 등)한 참여자는 방에서 제거 — 릴레이가 죽은 세션에 발목 잡히지 않게. */
    private fun send(flowId: String, id: String, p: Peer, node: ObjectNode) {
        try {
            p.session.sendMessage(TextMessage(mapper.writeValueAsString(node)))
        } catch (e: Exception) {
            log.debug("presence 전송 실패 → 제거 flow={} id={}: {}", flowId, id, e.message)
            rooms[flowId]?.remove(id)
            try { p.session.close(CloseStatus.SESSION_NOT_RELIABLE) } catch (ignored: Exception) { }
        }
    }

    companion object {
        private val log = LoggerFactory.getLogger(PresenceHandler::class.java)
        // 라이트/다크 양쪽에서 대비가 나오는 진한 팔레트(입장 순서 순환 배정)
        private val COLORS = listOf("#e11d48", "#2563eb", "#059669", "#d97706", "#7c3aed", "#0891b2")
    }
}
