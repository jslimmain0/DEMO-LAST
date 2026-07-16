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
        // 원자적 합류 — 마지막 leave 의 방 제거와 경쟁해도 유령 방/누락 없이 들어간다([A2]).
        val room = joinRoom(flowId, session.id) { color -> Peer(session, name, color) }
        val peer = room[session.id] ?: return
        val hello = mapper.createObjectNode()
        hello.put("t", "hello"); hello.put("id", session.id)
        val arr = hello.putArray("peers")
        room.forEach { (id, p) -> if (id != session.id) arr.add(peerJson(id, p)) }
        // hello 전송 실패로 새 피어가 즉시 퇴출됐으면 join 브로드캐스트하지 않는다(탄생 시 유령 방지, [A1]).
        if (!send(flowId, session.id, peer, hello)) return
        val join = mapper.createObjectNode()
        join.put("t", "join"); join.set<ObjectNode>("peer", peerJson(session.id, peer))
        broadcast(flowId, session.id, join)
        log.debug("presence join flow={} id={} name={} ({}명)", flowId, session.id, name, room.size)
    }

    /**
     * 방에 원자적으로 합류 — computeIfAbsent 로 방을 잡고 피어를 넣은 뒤, 그 사이 마지막 leave 가 방을
     * 제거했으면(현재 매핑이 다른 인스턴스) 재시도한다. 색은 방에서 현재 안 쓰는 것 우선(충돌 완화, [A3]).
     */
    private fun joinRoom(flowId: String, id: String, make: (String) -> Peer): ConcurrentHashMap<String, Peer> {
        while (true) {
            val room = rooms.computeIfAbsent(flowId) { ConcurrentHashMap() }
            val used = room.values.mapTo(HashSet()) { it.color }
            val color = COLORS.firstOrNull { it !in used } ?: COLORS[room.size % COLORS.size]
            room[id] = make(color)
            if (rooms[flowId] === room) return room
            room.remove(id) // 방이 동시에 제거됨 — 되돌리고 재시도
        }
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
        removePeer(flowId, session.id)
    }

    /**
     * 방에서 피어를 제거하는 단일 경로(정상 종료·전송 실패 퇴출 공용) — 실제로 있던 피어면 leave 를
     * 브로드캐스트하고 빈 방을 원자적으로 정리한다. 퇴출이 leave 를 안 쏘면 다른 참여자에게 유령으로
     * 영영 남는다([A1]). 빈 방 제거는 compute 로 join 과 경쟁해도 안전하게([A2]).
     */
    private fun removePeer(flowId: String, id: String) {
        val room = rooms[flowId] ?: return
        if (room.remove(id) == null) return
        rooms.compute(flowId) { _, r -> if (r == null || r.isEmpty()) null else r }
        val leave = mapper.createObjectNode()
        leave.put("t", "leave"); leave.put("id", id)
        broadcast(flowId, id, leave)
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

    /**
     * 전송 실패(끊긴 소켓 등)한 참여자는 방에서 제거하고 leave 를 브로드캐스트 — 릴레이가 죽은 세션에
     * 발목 잡히지 않게, 그리고 다른 참여자에게 유령으로 남지 않게([A1]). 성공 여부를 반환한다.
     * (제거는 removePeer 가 room.remove 로 1회만 처리하므로 중첩 브로드캐스트는 피어 수만큼으로 유한.)
     */
    private fun send(flowId: String, id: String, p: Peer, node: ObjectNode): Boolean {
        return try {
            p.session.sendMessage(TextMessage(mapper.writeValueAsString(node)))
            true
        } catch (e: Exception) {
            log.debug("presence 전송 실패 → 제거 flow={} id={}: {}", flowId, id, e.message)
            try { p.session.close(CloseStatus.SESSION_NOT_RELIABLE) } catch (ignored: Exception) { }
            removePeer(flowId, id)
            false
        }
    }

    companion object {
        private val log = LoggerFactory.getLogger(PresenceHandler::class.java)
        // 라이트/다크 양쪽에서 대비가 나오는 진한 팔레트(입장 순서 순환 배정)
        private val COLORS = listOf("#e11d48", "#2563eb", "#059669", "#d97706", "#7c3aed", "#0891b2")
    }
}
