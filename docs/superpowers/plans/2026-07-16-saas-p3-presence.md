# SaaS P3 — 실시간 협업 presence 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 워크플로를 연 사용자들끼리 커서·이름표·편집중 배지·저장 알림이 실시간으로 보인다(공동 편집/CRDT 없음 — 그래프는 서로 건드리지 않는다).

**Architecture:** 백엔드는 raw `TextWebSocketHandler`(`/ws/presence?flowId=…`, STOMP 미사용) — 방(flowId)별 참여자 최신 상태(커서/편집중)만 인메모리 보관하고 이벤트를 중계하는 릴레이. OIDC 모드에선 핸드셰이크에서 `?token=` JWT 검증 + flow 테넌트 소유 확인, dev 모드는 무인증. 프론트는 `lib/presence.ts`(연결·재연결·50ms 커서 쓰로틀) + 별도 `presenceStore`(editorStore 오염 금지 — dirty/undo 불변), 렌더링은 xyflow v12 `ViewportPortal`(flow 좌표에 두면 팬/줌 자동 추종).

**Tech Stack:** spring-boot-starter-websocket / Kotlin, zustand, @xyflow/react `ViewportPortal`, Node 24 내장 WebSocket(e2e).

## Global Constraints

- UI 텍스트는 전부 한국어. 코드 주석도 한국어(기존 코드베이스 관례).
- dev 모드(issuer-uri 미설정) 동작 무회귀 — 인증 없이 그대로 동작해야 한다.
- editorStore 를 오염시키지 않는다: presence 는 dirty/undo/selected 를 절대 건드리지 않는다(별도 presenceStore).
- Jackson 역직렬화 대상 Kotlin 클래스에 `@get:JvmName` 금지(프로젝트 규칙).
- KDoc/주석 안에 `/*` 시퀀스 금지(예: `/ws/**` 를 주석에 쓸 때 코틀린 중첩 블록 주석으로 파싱돼 컴파일 에러 — `이하 경로` 처럼 풀어 쓴다).
- reduced-motion 에서 무한 애니메이션 금지(기존 규칙) — 커서는 `transition` 80ms(1회성)만 사용.
- 백엔드 테스트 실행: `$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; ./gradlew :test`(루트 모듈만 — `--tests` 필터는 `:test` 에만).
- 프론트 검증: `npm run build`(tsc -b && vite build) + `npm run lint`(oxlint).

## 프로토콜 (JSON 텍스트 프레임)

클라이언트 → 서버 (전부 소문자 `t` 타입 필드):
- `{"t":"cursor","x":123.4,"y":56.7}` — flow 좌표계 커서. `{"t":"cursor","x":null,"y":null}` = 커서 숨김(캔버스 이탈).
- `{"t":"editing","nodeId":"n1"}` / `{"t":"editing","nodeId":null}` — 속성 패널에서 편집 중인 노드(선택 노드).
- `{"t":"saved"}` — 내가 저장함.

서버 → 클라이언트:
- 접속 직후 1회: `{"t":"hello","id":"<본인 세션id>","peers":[{"id","name","color","cursor":{x,y}|null,"editing":"n1"|null}, …]}` — 기존 참여자 스냅샷.
- `{"t":"join","peer":{id,name,color,cursor,editing}}` / `{"t":"leave","id":"…"}`
- 중계(보낸 사람 제외 + 서버가 `id` 부착): `{"t":"cursor","id","x","y"}` · `{"t":"editing","id","nodeId"}` · `{"t":"saved","id","name"}`

색은 서버가 방 입장 순서로 팔레트에서 배정. 이름은 dev=쿼리 `?name=`(40자 클램프), OIDC=JWT `preferred_username`(쿼리 무시).

---

### Task 1: 백엔드 presence 릴레이 코어 (PresenceHandler + 방 상태)

**Files:**
- Modify: `backend/build.gradle.kts` (websocket 스타터 의존성)
- Create: `backend/src/main/kotlin/com/flowlink/presence/PresenceHandler.kt`
- Test: `backend/src/test/kotlin/com/flowlink/presence/PresenceHandlerTest.kt`

**Interfaces:**
- Consumes: 세션 attributes `"flowId"`(String)·`"name"`(String) — Task 2 의 인터셉터가 채운다. 테스트에선 직접 주입.
- Produces: `PresenceHandler`(@Component, `TextWebSocketHandler` 상속) — Task 2 의 `PresenceConfig` 가 `/ws/presence` 에 등록.

- [ ] **Step 1: 의존성 추가**

`backend/build.gradle.kts` 의 `// --- Web / API ---` 블록에 추가:

```kotlin
    implementation("org.springframework.boot:spring-boot-starter-websocket")
```

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/src/test/kotlin/com/flowlink/presence/PresenceHandlerTest.kt`:

```kotlin
package com.flowlink.presence

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.JsonNode
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

/** 전송 프레임을 기록하는 가짜 세션 — 네트워크 없이 릴레이 로직을 검증한다. */
class FakeSession(private val id: String, flowId: String, name: String) : WebSocketSession {
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
    override fun sendMessage(message: WebSocketMessage<*>) { sent.add((message as TextMessage).payload) }
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
```

- [ ] **Step 3: 실패 확인**

```powershell
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; ./gradlew :test --tests "com.flowlink.presence.*"
```
Expected: FAIL — `PresenceHandler` 미존재(컴파일 에러).

- [ ] **Step 4: PresenceHandler 구현**

`backend/src/main/kotlin/com/flowlink/presence/PresenceHandler.kt`:

```kotlin
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
        if (p.cursor != null) {
            val c = n.putObject("cursor")
            c.set<JsonNode>("x", p.cursor!!.path("x")); c.set<JsonNode>("y", p.cursor!!.path("y"))
        } else n.putNull("cursor")
        if (p.editing != null) n.put("editing", p.editing) else n.putNull("editing")
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
```

주의: 테스트가 `handler.handleMessage(...)` 를 부른다 — `TextWebSocketHandler.handleMessage` 가 `handleTextMessage` 로 위임하므로 그대로 동작한다. 또 hello 전송 시 데코레이터 세션의 id 는 raw 세션 id 와 같다(FakeSession "A"/"B" 그대로).

- [ ] **Step 5: 테스트 통과 확인**

```powershell
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; ./gradlew :test --tests "com.flowlink.presence.*"
```
Expected: 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/build.gradle.kts backend/src/main/kotlin/com/flowlink/presence/PresenceHandler.kt backend/src/test/kotlin/com/flowlink/presence/PresenceHandlerTest.kt
git commit -m "feat(presence): 방(flowId)별 presence 릴레이 핸들러 — hello 스냅샷·커서/편집중/저장 중계"
```

---

### Task 2: 핸드셰이크 인터셉터(dev 무인증 + OIDC JWT·테넌트 검증) + 배선

**Files:**
- Create: `backend/src/main/kotlin/com/flowlink/presence/PresenceHandshakeInterceptor.kt`
- Create: `backend/src/main/kotlin/com/flowlink/presence/PresenceConfig.kt`
- Modify: `backend/src/main/kotlin/com/flowlink/security/SecurityConfig.kt` (PUBLIC_PATHS 에 `/ws/**`)
- Modify: `backend/src/main/kotlin/com/flowlink/common/web/SpaStaticConfig.kt` (NO_FALLBACK_PREFIXES 에 `ws/`)
- Test: `backend/src/test/kotlin/com/flowlink/presence/PresenceHandshakeInterceptorTest.kt`

**Interfaces:**
- Consumes: `PresenceHandler`(Task 1), `SecurityProperties.tenantClaim`, `FlowRepository.findByIdAndTenantId(id: UUID, tenantId: String): Optional<Flow>`
- Produces: `PresenceHandshakeInterceptor(decoder: JwtDecoder?, tenantClaim: String, flowAccessCheck: (UUID, String) -> Boolean)` — 통과 시 attributes `flowId`/`name` 설정. `/ws/presence` 등록 완료.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/src/test/kotlin/com/flowlink/presence/PresenceHandshakeInterceptorTest.kt`:

```kotlin
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
        // ServletServerHttpRequest 는 uri 를 queryString 포함으로 조립한다
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
```

- [ ] **Step 2: 실패 확인**

```powershell
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; ./gradlew :test --tests "com.flowlink.presence.PresenceHandshakeInterceptorTest"
```
Expected: FAIL — `PresenceHandshakeInterceptor` 미존재.

- [ ] **Step 3: 인터셉터 구현**

`backend/src/main/kotlin/com/flowlink/presence/PresenceHandshakeInterceptor.kt`:

```kotlin
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
 */
class PresenceHandshakeInterceptor(
    private val decoder: JwtDecoder?,
    private val tenantClaim: String,
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
        val token = params.getFirst("token") ?: return refuse(response, HttpStatus.UNAUTHORIZED)
        val jwt = try { decoder.decode(token) } catch (e: JwtException) {
            return refuse(response, HttpStatus.UNAUTHORIZED)
        }
        val tenant = jwt.getClaimAsString(tenantClaim) ?: "default"
        if (!flowAccessCheck(uuid, tenant)) return refuse(response, HttpStatus.FORBIDDEN)
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
```

- [ ] **Step 4: 설정 클래스 + 보안/SPA 배선**

`backend/src/main/kotlin/com/flowlink/presence/PresenceConfig.kt`:

```kotlin
package com.flowlink.presence

import com.flowlink.core.repository.FlowRepository
import com.flowlink.security.SecurityProperties
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Configuration
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.web.socket.config.annotation.EnableWebSocket
import org.springframework.web.socket.config.annotation.WebSocketConfigurer
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry

/** presence WebSocket 등록 — 경로 /ws/presence, 핸드셰이크에서 인증·테넌트 검증. */
@Configuration
@EnableWebSocket
class PresenceConfig(
    private val handler: PresenceHandler,
    private val decoderProvider: ObjectProvider<JwtDecoder>,
    private val props: SecurityProperties,
    private val flowRepository: FlowRepository,
) : WebSocketConfigurer {

    override fun registerWebSocketHandlers(registry: WebSocketHandlerRegistry) {
        val interceptor = PresenceHandshakeInterceptor(
            decoderProvider.getIfAvailable(), props.tenantClaim,
        ) { id, tenant -> flowRepository.findByIdAndTenantId(id, tenant).isPresent }
        registry.addHandler(handler, "/ws/presence")
            .addInterceptors(interceptor)
            .setAllowedOrigins("*")   // 사내 도구 전제 + 핸드셰이크에서 자체 검증(OIDC 모드)
    }
}
```

`SecurityConfig.kt` 의 `PUBLIC_PATHS` 배열 마지막에 추가(주석에 `/ws/**` 같은 별표 경로를 쓰면 코틀린 중첩 주석이 되므로 풀어 쓴다):

```kotlin
            // presence WebSocket 핸드셰이크 — 브라우저 WebSocket 은 Authorization 헤더를 못 실어
            // 인터셉터가 쿼리 token 으로 자체 검증한다(PresenceHandshakeInterceptor)
            "/ws/**",
```

`SpaStaticConfig.kt` 의 `NO_FALLBACK_PREFIXES` 에 `"ws/"` 추가:

```kotlin
        private val NO_FALLBACK_PREFIXES = listOf(
            "api/", "mock/", "relay/", "actuator/", "swagger-ui", "v3/", "h2-console", "ws/",
        )
```

- [ ] **Step 5: 전체 백엔드 테스트 통과 확인**

```powershell
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; ./gradlew :test
```
Expected: 기존 전부 + presence 11 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/kotlin/com/flowlink/presence/ backend/src/test/kotlin/com/flowlink/presence/ backend/src/main/kotlin/com/flowlink/security/SecurityConfig.kt backend/src/main/kotlin/com/flowlink/common/web/SpaStaticConfig.kt
git commit -m "feat(presence): 핸드셰이크 인증(dev 오픈·OIDC JWT+테넌트 검증) + /ws/presence 등록"
```

---

### Task 3: dev 모드 WebSocket e2e 스크립트

**Files:**
- Create: `e2e/saas-p3-presence.mjs`

**Interfaces:**
- Consumes: 백엔드(:18080, dev H2 모드) — `/api/v1/flows` REST, `/ws/presence` WebSocket(Node 24 내장 `WebSocket` 클라이언트).
- Produces: 독립 실행 스크립트(`node e2e/saas-p3-presence.mjs`, exit 0=전부 PASS).

- [ ] **Step 1: 스크립트 작성**

`e2e/saas-p3-presence.mjs`:

```javascript
#!/usr/bin/env node
/**
 * SaaS P3 e2e — presence 릴레이(dev 모드) 검증.
 * 전제: 백엔드가 dev(H2) 모드로 :18080 실행 중. Node 24+(내장 WebSocket).
 * 실행: node e2e/saas-p3-presence.mjs
 */
const BASE = process.env.FLOWLINK_BASE || 'http://localhost:18080'
const WS = BASE.replace(/^http/, 'ws')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, body) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return r.json().catch(() => null)
}

/** 수신 메시지를 쌓아두고 조건 대기하는 WebSocket 래퍼. */
function connect(flowId, name) {
  const ws = new WebSocket(`${WS}/ws/presence?flowId=${flowId}&name=${encodeURIComponent(name)}`)
  const inbox = []
  ws.onmessage = (ev) => inbox.push(JSON.parse(ev.data))
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  async function waitFor(pred, timeoutMs = 5000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const hit = inbox.find(pred)
      if (hit) return hit
      await sleep(50)
    }
    return null
  }
  return { ws, inbox, opened, waitFor, send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close() }
}

async function main() {
  const flow = await api('POST', '/flows', { name: 'p3-presence' })
  const flow2 = await api('POST', '/flows', { name: 'p3-presence-2' })

  console.log('== ① 입장/스냅샷/브로드캐스트 ==')
  const a = connect(flow.id, '앨리스'); await a.opened
  const helloA = await a.waitFor((m) => m.t === 'hello')
  ok('A hello(빈 방)', helloA && helloA.peers.length === 0, JSON.stringify(helloA))
  const b = connect(flow.id, '밥'); await b.opened
  const helloB = await b.waitFor((m) => m.t === 'hello')
  ok('B hello 에 A 스냅샷', helloB?.peers?.length === 1 && helloB.peers[0].name === '앨리스')
  const joinAtA = await a.waitFor((m) => m.t === 'join')
  ok('A 가 B join 수신(색 배정)', joinAtA?.peer?.name === '밥' && !!joinAtA?.peer?.color)

  console.log('== ② 커서/편집중/저장 중계 ==')
  b.send({ t: 'cursor', x: 100.5, y: 200 })
  const cur = await a.waitFor((m) => m.t === 'cursor')
  ok('커서 중계(+id)', cur?.x === 100.5 && cur?.id === helloB.id)
  ok('본인에겐 미중계', !b.inbox.some((m) => m.t === 'cursor'))
  b.send({ t: 'editing', nodeId: 'n1' })
  const ed = await a.waitFor((m) => m.t === 'editing')
  ok('편집중 중계', ed?.nodeId === 'n1')
  b.send({ t: 'saved' })
  const sv = await a.waitFor((m) => m.t === 'saved')
  ok('저장 알림(이름 포함)', sv?.name === '밥')

  console.log('== ③ 늦은 입장자 스냅샷 + 방 격리 + 퇴장 ==')
  const c = connect(flow.id, '캐럴'); await c.opened
  const helloC = await c.waitFor((m) => m.t === 'hello')
  const bobSnap = helloC?.peers?.find((p) => p.name === '밥')
  ok('늦은 입장자에 밥의 최근 상태', bobSnap?.cursor?.x === 100.5 && bobSnap?.editing === 'n1', JSON.stringify(bobSnap))
  const x = connect(flow2.id, '외부인'); await x.opened
  await x.waitFor((m) => m.t === 'hello')
  x.send({ t: 'cursor', x: 1, y: 1 })
  await sleep(400)
  ok('다른 flow 이벤트 격리', !a.inbox.some((m) => m.t === 'join' && m.peer?.name === '외부인'))
  b.close()
  const lv = await a.waitFor((m) => m.t === 'leave')
  ok('퇴장 브로드캐스트', lv?.id === helloB.id)

  console.log('== ④ 핸드셰이크 검증 ==')
  const bad = new WebSocket(`${WS}/ws/presence?flowId=not-a-uuid`)
  const badResult = await new Promise((res) => { bad.onerror = () => res('err'); bad.onopen = () => res('open') })
  ok('비 UUID flowId 거절', badResult === 'err')

  a.close(); c.close(); x.close()
  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('e2e 실패:', e); process.exit(1) })
```

- [ ] **Step 2: 백엔드 재빌드·재기동 후 실행**

```powershell
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; ./gradlew bootJar -x test
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1 -KeepDb
powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -H2 -NoDb
node e2e/saas-p3-presence.mjs
```
Expected: `결과: 11 PASS / 0 FAIL`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add e2e/saas-p3-presence.mjs
git commit -m "test(e2e): P3 presence 릴레이 dev e2e — 스냅샷/중계/격리/퇴장/핸드셰이크 11 단언"
```

---

### Task 4: 프론트 presence 클라이언트 + presenceStore + vite 프록시

**Files:**
- Create: `frontend/src/store/presenceStore.ts`
- Create: `frontend/src/lib/presence.ts`
- Modify: `frontend/vite.config.ts` (`/ws` 프록시)

**Interfaces:**
- Consumes: `components/toast.tsx` 의 `toast(msg)`, 브라우저 `WebSocket`.
- Produces:
  - `usePresenceStore` — `{ selfId: string|null, peers: Record<string, Peer> }` + 액션(`hello/join/leave/cursor/editing/reset`). `Peer = { id, name, color, cursor: {x,y}|null, editing: string|null }`
  - `presence`(모듈 싱글턴) — `connect(flowId, name, tokenFn?)`, `sendCursor(x,y)`, `hideCursor()`, `sendEditing(nodeId|null)`, `sendSaved()`, `close()`
  - `devNickname(): string` — dev 모드 로컬 닉네임(localStorage `fl:nick`)

- [ ] **Step 1: presenceStore 작성**

`frontend/src/store/presenceStore.ts`:

```typescript
import { create } from 'zustand'

/** 원격 참여자 한 명 — editorStore 와 완전히 분리(dirty/undo/selected 불변). */
export interface Peer {
  id: string
  name: string
  color: string
  cursor: { x: number; y: number } | null
  editing: string | null
}

interface PresenceState {
  selfId: string | null
  peers: Record<string, Peer>
  hello: (id: string, peers: Peer[]) => void
  join: (peer: Peer) => void
  leave: (id: string) => void
  cursor: (id: string, x: number | null, y: number | null) => void
  editing: (id: string, nodeId: string | null) => void
  reset: () => void
}

export const usePresenceStore = create<PresenceState>((set) => ({
  selfId: null,
  peers: {},
  hello: (id, peers) =>
    set({ selfId: id, peers: Object.fromEntries(peers.map((p) => [p.id, p])) }),
  join: (peer) => set((s) => ({ peers: { ...s.peers, [peer.id]: peer } })),
  leave: (id) =>
    set((s) => {
      const peers = { ...s.peers }
      delete peers[id]
      return { peers }
    }),
  cursor: (id, x, y) =>
    set((s) => {
      const p = s.peers[id]
      if (!p) return s
      return { peers: { ...s.peers, [id]: { ...p, cursor: x == null || y == null ? null : { x, y } } } }
    }),
  editing: (id, nodeId) =>
    set((s) => {
      const p = s.peers[id]
      if (!p) return s
      return { peers: { ...s.peers, [id]: { ...p, editing: nodeId } } }
    }),
  reset: () => set({ selfId: null, peers: {} }),
}))
```

- [ ] **Step 2: presence 세션 작성**

`frontend/src/lib/presence.ts`:

```typescript
import { toast } from '../components/toast'
import { usePresenceStore, type Peer } from '../store/presenceStore'

/** dev 모드 닉네임 — 브라우저별 1회 생성해 localStorage 에 유지. */
export function devNickname(): string {
  let n = localStorage.getItem('fl:nick')
  if (!n) {
    n = '게스트-' + Math.random().toString(36).slice(2, 6)
    localStorage.setItem('fl:nick', n)
  }
  return n
}

const CURSOR_MS = 50 // 커서 전송 쓰로틀(트레일링 — 마지막 위치는 반드시 전송)

/**
 * presence WebSocket 세션(에디터당 1개 — 모듈 싱글턴).
 * 끊기면 2초 후 자동 재접속(사용자가 close 하기 전까지). 수신은 presenceStore 로만 반영.
 */
class PresenceSession {
  private ws: WebSocket | null = null
  private flowId: string | null = null
  private name = ''
  private tokenFn: (() => string | null) | null = null
  private retry: number | undefined
  private lastSent = 0
  private pending: { x: number | null; y: number | null } | null = null
  private cursorTimer: number | undefined

  connect(flowId: string, name: string, tokenFn?: () => string | null) {
    this.close()
    this.flowId = flowId
    this.name = name
    this.tokenFn = tokenFn ?? null
    this.open()
  }

  private open() {
    if (!this.flowId) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let url = `${proto}://${location.host}/ws/presence?flowId=${this.flowId}&name=${encodeURIComponent(this.name)}`
    const token = this.tokenFn?.()
    if (token) url += `&token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    ws.onmessage = (ev) => {
      try { this.dispatch(JSON.parse(ev.data as string)) } catch { /* 무시 */ }
    }
    ws.onclose = () => {
      usePresenceStore.getState().reset()
      if (this.ws === ws) {
        this.ws = null
        // 사용자가 close() 한 게 아니면 재접속(백엔드 재시작·네트워크 순단 대응)
        this.retry = window.setTimeout(() => this.open(), 2000)
      }
    }
    this.ws = ws
  }

  private dispatch(m: { t: string } & Record<string, unknown>) {
    const st = usePresenceStore.getState()
    switch (m.t) {
      case 'hello': st.hello(m.id as string, m.peers as Peer[]); break
      case 'join': st.join(m.peer as Peer); break
      case 'leave': st.leave(m.id as string); break
      case 'cursor': st.cursor(m.id as string, m.x as number | null, m.y as number | null); break
      case 'editing': st.editing(m.id as string, m.nodeId as string | null); break
      case 'saved': toast(`${m.name} 님이 이 워크플로를 저장했습니다`); break
    }
  }

  private send(o: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o))
  }

  /** 50ms 트레일링 쓰로틀 — 조용해지면 마지막 좌표가 반드시 나간다. */
  sendCursor(x: number, y: number) {
    this.pending = { x, y }
    const now = Date.now()
    if (now - this.lastSent >= CURSOR_MS) this.flushCursor()
    else if (this.cursorTimer === undefined) {
      this.cursorTimer = window.setTimeout(() => this.flushCursor(), CURSOR_MS - (now - this.lastSent))
    }
  }

  hideCursor() {
    this.pending = { x: null, y: null }
    this.flushCursor()
  }

  private flushCursor() {
    if (this.cursorTimer !== undefined) { clearTimeout(this.cursorTimer); this.cursorTimer = undefined }
    if (!this.pending) return
    this.lastSent = Date.now()
    this.send({ t: 'cursor', ...this.pending })
    this.pending = null
  }

  sendEditing(nodeId: string | null) { this.send({ t: 'editing', nodeId }) }
  sendSaved() { this.send({ t: 'saved' }) }

  close() {
    if (this.retry !== undefined) { clearTimeout(this.retry); this.retry = undefined }
    if (this.cursorTimer !== undefined) { clearTimeout(this.cursorTimer); this.cursorTimer = undefined }
    const ws = this.ws
    this.ws = null // onclose 의 재접속 분기 차단
    ws?.close()
    usePresenceStore.getState().reset()
    this.flowId = null
    this.pending = null
  }
}

export const presence = new PresenceSession()
```

- [ ] **Step 3: vite 프록시 추가**

`frontend/vite.config.ts` 의 proxy 에:

```typescript
      '/ws': { target: 'ws://localhost:18080', ws: true },
```

- [ ] **Step 4: 타입 체크**

```powershell
cd frontend; npx tsc -b
```
Expected: 에러 없음.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/presenceStore.ts frontend/src/lib/presence.ts frontend/vite.config.ts
git commit -m "feat(front): presence 클라이언트(재접속·커서 쓰로틀) + presenceStore + /ws 프록시"
```

---

### Task 5: 캔버스 커서/편집중 오버레이 + 헤더 아바타 + 에디터 배선

**Files:**
- Create: `frontend/src/canvas/PresenceOverlay.tsx`
- Create: `frontend/src/components/PresenceAvatars.tsx`
- Modify: `frontend/src/canvas/FlowCanvas.tsx` (오버레이 삽입 + 포인터 추적)
- Modify: `frontend/src/routes/Editor.tsx` (세션 연결/해제·selectedId→editing·저장 알림·아바타)

**Interfaces:**
- Consumes: `presence`/`devNickname`(Task 4), `usePresenceStore`, `useAuth()`(`me.username`, `enabled`), `getAccessToken`(auth/auth.ts), `useEditorStore`(nodes·selectedId 구독만 — 쓰기 없음), xyflow `ViewportPortal`·`useReactFlow().screenToFlowPosition`.
- Produces: `<PresenceOverlay />`(FlowCanvas 내부), `<PresenceAvatars />`(Editor 헤더).

- [ ] **Step 1: PresenceOverlay 작성**

`frontend/src/canvas/PresenceOverlay.tsx`:

```tsx
import { ViewportPortal } from '@xyflow/react'
import { usePresenceStore } from '../store/presenceStore'
import { useEditorStore } from '../store/editorStore'

/**
 * 원격 참여자 표시 — flow 좌표계에 그리는 ViewportPortal(팬/줌 자동 추종).
 * 커서(화살표+이름표)와 편집중 링(노드 테두리+✎ 배지). 전부 pointer-events 없음(캔버스 조작 방해 금지).
 */
export function PresenceOverlay() {
  const peers = usePresenceStore((s) => s.peers)
  const nodes = useEditorStore((s) => s.nodes)
  const list = Object.values(peers)
  if (list.length === 0) return null
  return (
    <ViewportPortal>
      {list.map((p) => {
        if (!p.editing) return null
        const n = nodes.find((nd) => nd.id === p.editing)
        if (!n) return null
        const w = (n.measured?.width ?? 230) + 12
        const h = (n.measured?.height ?? 80) + 12
        return (
          <div key={`ring-${p.id}`} style={{
            position: 'absolute', transform: `translate(${n.position.x - 6}px, ${n.position.y - 6}px)`,
            width: w, height: h, border: `2px solid ${p.color}`, borderRadius: 14,
            pointerEvents: 'none', zIndex: 5,
          }}>
            <span style={{
              position: 'absolute', top: -22, left: 0, background: p.color, color: '#fff',
              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
            }}>✎ {p.name}</span>
          </div>
        )
      })}
      {list.map((p) => p.cursor && (
        <div key={`cur-${p.id}`} style={{
          position: 'absolute', transform: `translate(${p.cursor.x}px, ${p.cursor.y}px)`,
          pointerEvents: 'none', zIndex: 6, transition: 'transform 80ms linear',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" style={{ display: 'block' }}>
            <path d="M4 2 L20 12 L12 13.5 L9 21 Z" fill={p.color} stroke="#fff" strokeWidth="1.5" />
          </svg>
          <span style={{
            marginLeft: 10, background: p.color, color: '#fff', fontSize: 11, fontWeight: 600,
            padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
          }}>{p.name}</span>
        </div>
      ))}
    </ViewportPortal>
  )
}
```

- [ ] **Step 2: FlowCanvas 배선**

`frontend/src/canvas/FlowCanvas.tsx`:
- import 추가: `import { PresenceOverlay } from './PresenceOverlay'` · `import { presence } from '../lib/presence'`
- `<ReactFlow …>` 의 자식(기존 `<Background/>` 등 옆)에 `<PresenceOverlay />` 추가.
- 래퍼(또는 ReactFlow)의 포인터 추적 — 기존 `className={…'fl-canvas'}` 를 주는 래퍼 div 에 핸들러 추가:

```tsx
      onPointerMove={(e) => {
        const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        presence.sendCursor(p.x, p.y)
      }}
      onPointerLeave={() => presence.hideCursor()}
```

(`screenToFlowPosition` 은 이미 `useReactFlow()` 로 가져와 있음.)

- [ ] **Step 3: PresenceAvatars 작성**

`frontend/src/components/PresenceAvatars.tsx`:

```tsx
import { usePresenceStore } from '../store/presenceStore'

/** 헤더 참여자 아바타 스택 — 이니셜 원, 겹침 배치, 5명 초과는 +N. */
export function PresenceAvatars() {
  const peers = usePresenceStore((s) => s.peers)
  const list = Object.values(peers)
  if (list.length === 0) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center' }} aria-label={`함께 보는 중: ${list.map((p) => p.name).join(', ')}`}>
      {list.slice(0, 5).map((p, i) => (
        <span key={p.id} title={p.name} style={{
          width: 26, height: 26, borderRadius: '50%', background: p.color, color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 700, border: '2px solid var(--fl-surface)',
          marginLeft: i === 0 ? 0 : -8,
        }}>{p.name.slice(0, 1).toUpperCase()}</span>
      ))}
      {list.length > 5 && (
        <span style={{ fontSize: 11, marginLeft: 4, color: 'var(--fl-text-muted)' }}>+{list.length - 5}</span>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Editor 배선**

`frontend/src/routes/Editor.tsx`:
- import 추가: `presence, devNickname`(lib/presence) · `PresenceAvatars`(components) · `getAccessToken`(auth/auth) · `useAuth`(auth/AuthContext — 기존 usePermissions import 옆).
- 세션 수명 useEffect(플로우 로드 후 — `id` 는 useParams 플로우 id):

```tsx
  // presence — 같은 플로우를 연 사람들끼리 커서/편집중/저장 알림(별도 presenceStore, 그래프 불변)
  const { me, enabled: authEnabled } = useAuth()
  useEffect(() => {
    if (!id) return
    presence.connect(id, me?.username ?? devNickname(), authEnabled ? getAccessToken : undefined)
    // 선택 노드 변경 → 편집중 신호(속성 패널이 그 노드를 편집 중)
    const unsub = useEditorStore.subscribe((s, prev) => {
      if (s.selectedId !== prev.selectedId) presence.sendEditing(s.selectedId)
    })
    return () => { unsub(); presence.close() }
  }, [id, me?.username, authEnabled])
```

- 저장 성공 알림 — 기존 `const save = useMutation({ mutationFn…, onError… })` 에 `onSuccess` 추가:

```tsx
    onSuccess: () => presence.sendSaved(),
```

(주의: 기존 onSuccess 가 이미 있으면 그 안에 한 줄 추가 — 덮어쓰지 말 것.)
- 헤더의 `● 미저장/저장됨` 스팬 옆(실행 버튼 앞)에 `<PresenceAvatars />` 삽입.

- [ ] **Step 5: 빌드·린트**

```powershell
cd frontend; npm run build; npm run lint
```
Expected: tsc/vite/oxlint 전부 통과.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/canvas/PresenceOverlay.tsx frontend/src/components/PresenceAvatars.tsx frontend/src/canvas/FlowCanvas.tsx frontend/src/routes/Editor.tsx
git commit -m "feat(front): 캔버스 원격 커서/편집중 링(ViewportPortal) + 헤더 아바타 + 저장 알림 토스트"
```

---

### Task 6: 브라우저 2탭 검증 + CLAUDE.md 갱신

**Files:**
- Modify: `CLAUDE.md` (P3 섹션 추가)

- [ ] **Step 1: 스택 기동 + 2탭 검증**

백엔드(dev H2)·vite(:5173) 기동 후 같은 플로우를 두 탭으로 연다(Chrome 자동화 또는 수동):
1. 탭 A 에서 캔버스 위 마우스 이동 → 탭 B 에 색 커서+이름표가 따라온다.
2. 탭 A 에서 노드 클릭(선택) → 탭 B 그 노드에 색 링+`✎ 이름` 배지.
3. 탭 A 에서 노드를 수정 후 저장 → 탭 B 에 "…님이 이 워크플로를 저장했습니다" 토스트.
4. 두 탭 모두 헤더에 상대 아바타 1개(자기 자신은 미표시 — peers 는 hello 스냅샷+join 만).
5. 탭 B 닫기 → 탭 A 아바타/커서 사라짐(leave).
6. 백엔드 재시작 → 2초 후 자동 재접속(아바타 복귀).
7. 실행 중 애니메이션·undo/redo·dirty 플래그가 presence 로 인해 오동작하지 않는지 확인(editorStore 불변).

- [ ] **Step 2: CLAUDE.md P3 섹션 추가 + Commit**

"최근 변경 (2026-07-16) — SaaS 전환 P2" 섹션 뒤에 P3 요약 섹션을 추가(구현 내용·검증 결과·한계: 인메모리 방 상태(재시작 시 스냅샷 소실—클라 재접속으로 복구), 커서만 릴레이(공동 편집 아님), token 이 쿼리스트링(사내 도구 전제)).

```bash
git add CLAUDE.md
git commit -m "docs: SaaS P3(실시간 presence) CLAUDE.md 갱신"
```

---

## Self-Review 결과

- **스펙 커버리지**: §5 의 모든 항목이 태스크에 매핑됨 — starter-websocket+raw handler(T1), OIDC 핸드셰이크 token 검증+테넌트 확인·dev 오픈(T2), SpaStaticConfig ws 제외·vite proxy(T2/T4), lib/presence 50ms 쓰로틀·재연결(T4), 별도 presenceStore(T4), ViewportPortal 커서/선택 링(T5), 헤더 아바타(T5), saved 토스트(T4/T5), OIDC=/me·dev=localStorage 닉네임(T5), reduced-motion 무한 펄스 없음(transition 1회성, T5), 2탭 e2e(T6). "선택 링" 은 selection/editing 을 editing 신호 하나로 통합(이 앱에서 선택=속성 패널 편집이라 동일 의미 — 메시지 수 절감).
- **플레이스홀더 없음**: 모든 코드 스텝에 실제 코드 포함.
- **타입 일관성**: `Peer` 형태(id/name/color/cursor/editing)가 백엔드 peerJson·프론트 presenceStore·e2e 단언에서 동일. `presence.connect(flowId, name, tokenFn?)`·`sendEditing(nodeId|null)` 시그니처가 T4 정의와 T5 사용처 일치.
