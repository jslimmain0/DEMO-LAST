package com.flowlink.desktop

import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.config.annotation.WebSocketConfigurer
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator
import org.springframework.web.socket.handler.TextWebSocketHandler
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.net.http.WebSocket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** 원격 공동 편집도 앱의 로그인 세션을 사용한다. JWT를 브라우저에 전달하지 않는다. */
@Configuration
@Profile("desktop")
class DesktopPresence(private val connection: DesktopConnection,
    @org.springframework.beans.factory.annotation.Value("\${server.port}") private val port: Int) : TextWebSocketHandler(), WebSocketConfigurer {
    private val peers = ConcurrentHashMap<String, Pair<WebSocketSession, WebSocket>>()
    override fun registerWebSocketHandlers(registry: WebSocketHandlerRegistry) {
        registry.addHandler(this, "/remote/ws/presence").setAllowedOrigins("http://127.0.0.1:$port")
    }

    override fun afterConnectionEstablished(session: WebSocketSession) {
        try {
            val query = session.uri?.rawQuery.orEmpty().split('&').mapNotNull {
                val parts = it.split('=', limit = 2)
                if (parts.size == 2) parts[0] to URLDecoder.decode(parts[1], Charsets.UTF_8) else null
            }.toMap()
            val flow = UUID.fromString(query["flowId"] ?: error("flowId 필요"))
            val name = URLEncoder.encode(query["name"].orEmpty().take(80), Charsets.UTF_8)
            val uri = URI.create(connection.serverUrl().replaceFirst("https:", "wss:").replaceFirst("http:", "ws:") +
                "/ws/presence?flowId=$flow&name=$name&token=${connection.token()}")
            val downstream = ConcurrentWebSocketSessionDecorator(session, 10_000, 1024 * 1024)
            val upstream = connection.client.newWebSocketBuilder().buildAsync(uri, object : WebSocket.Listener {
                private val text = StringBuilder()
                override fun onOpen(socket: WebSocket) { socket.request(1) }
                override fun onText(socket: WebSocket, data: CharSequence, last: Boolean): java.util.concurrent.CompletionStage<*>? {
                    text.append(data)
                    if (text.length > 1024 * 1024) { socket.abort(); downstream.close(CloseStatus.TOO_BIG_TO_PROCESS); return null }
                    if (last) { if (downstream.isOpen) downstream.sendMessage(TextMessage(text.toString())); text.setLength(0) }
                    socket.request(1); return null
                }
                override fun onClose(socket: WebSocket, statusCode: Int, reason: String): java.util.concurrent.CompletionStage<*>? {
                    peers.remove(session.id); if (downstream.isOpen) downstream.close(); return null
                }
                override fun onError(socket: WebSocket, error: Throwable) { peers.remove(session.id); if (downstream.isOpen) downstream.close(CloseStatus.SERVER_ERROR) }
            }).join()
            peers[session.id] = downstream to upstream
        } catch (_: Exception) { session.close(CloseStatus.POLICY_VIOLATION) }
    }

    override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
        peers[session.id]?.second?.sendText(message.payload, true)?.join()
    }
    override fun afterConnectionClosed(session: WebSocketSession, status: CloseStatus) { peers.remove(session.id)?.second?.abort() }
    @org.springframework.context.event.EventListener
    fun disconnect(event: DesktopServerDisconnected) {
        peers.values.toList().forEach { (local, remote) -> remote.abort(); if (local.isOpen) local.close() }; peers.clear()
    }
}
