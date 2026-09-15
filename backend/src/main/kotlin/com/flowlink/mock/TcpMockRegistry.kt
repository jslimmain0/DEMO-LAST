package com.flowlink.mock

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.core.domain.MockServer
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.execution.engine.SecretMasker
import com.flowlink.protocol.ProtocolChangedEvent
import com.flowlink.protocol.ProtocolCodec
import com.flowlink.protocol.ProtocolService
import com.flowlink.protocol.ProtocolSpec
import com.flowlink.transform.TransformRegistry
import jakarta.annotation.PreDestroy
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import org.springframework.transaction.event.TransactionPhase
import org.springframework.transaction.event.TransactionalEventListener
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * TCP mock 리스너 수명 관리 — mock 서버 spec 의 tcp 섹션(포트 + 프로토콜 참조)이 있고 enabled 면 지정 포트에
 * ServerSocket 을 열고, 연결 하나하나를 [TcpMockSession] 에 위임한다(규칙 매칭·응답 조립·proxy·장애 주입·트래픽 로그).
 *
 * <p>HTTP mock(/mock/{slug}/…)과 동일한 "테스트 도구" 전제 — 무인증.
 * 리스너는 mock 저장/토글/삭제(MockServerService)와 앱 기동 시(ApplicationReady) 동기화되고,
 * 프로토콜 저장([ProtocolChangedEvent])은 열린 리스너에 핫스왑된다.
 * 포트 바인딩 실패·충돌은 저장 시점에 BadRequest 로 표면화(조용한 실패 방지).
 */
@Component
class TcpMockRegistry(
    private val json: JsonService,
    private val repository: MockServerRepository,
    private val transforms: TransformRegistry,
    private val store: MockRuntimeStore,
    private val secretProvider: MockSecretProvider,
    private val protocols: ProtocolService,
) {

    private class Listener(
        val mockId: UUID,
        val tenantId: String,
        val port: Int,
        val socket: ServerSocket,
        @Volatile var tcp: MockSpec.MockTcp,
        @Volatile var protocol: ProtocolSpec,
        @Volatile var environment: String?        // 시크릿 스코프({{ 이름@secret }})
    )

    private val listeners = ConcurrentHashMap<UUID, Listener>() // mock 서버 id → 리스너
    /** 기동 시 바인딩 실패(포트 선점 등) — 저장 시점 실패는 400 으로 롤백되지만 재기동 실패는 조용해서 서버 현황에 빨간불로 노출한다. */
    private val failures = ConcurrentHashMap<UUID, String>()

    /** 실제로 열려 있는 리스너 포트(없으면 null) — spec 의 port 와 달리 "지금 소켓이 바인딩돼 있는가". */
    fun listeningPort(id: UUID): Int? = listeners[id]?.port

    /** 기동 시 바인딩 실패 메시지(없으면 null). */
    fun bindFailure(id: UUID): String? = failures[id]

    @EventListener(ApplicationReadyEvent::class)
    fun startAll() {
        for (m in repository.findAll()) {
            try {
                sync(m)
            } catch (e: Exception) {
                // 기동 시 실패(포트 선점 등)는 로그만 — 서버 전체를 죽이지 않는다. 서버 현황(fleet)이 빨간불로 보여준다.
                log.warn("TCP mock 기동 실패(slug={}): {}", m.slug, e.message)
                failures[m.id] = e.message ?: "바인딩 실패"
            }
        }
    }

    /** 프로토콜 저장 → 그 프로토콜을 쓰는 열린 리스너에 반영(재시작 불필요). 커밋 후에만 — 롤백된 저장이 리스너를 바꾸면 안 된다. */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    fun onProtocolChanged(e: ProtocolChangedEvent) {
        for (l in listeners.values) if (l.tcp.protocolId?.trim() == e.id.toString()) l.protocol = e.spec
    }

    @PreDestroy
    fun stopAll() {
        listeners.keys.toList().forEach { stop(it) }
    }

    /**
     * mock 서버 한 개의 원하는 상태(spec.tcp × enabled)와 실제 리스너를 맞춘다.
     * 포트 바인딩 실패/다른 mock 과의 충돌·없는 프로토콜은 BadRequestException — 저장 트랜잭션이 롤백된다.
     */
    fun sync(m: MockServer) {
        val spec = parseSpecQuiet(m.specJson)
        val tcp = spec?.tcp
        val want = m.isEnabled && tcp != null && tcp.port != null && !tcp.protocolId.isNullOrBlank()
        if (!want) {
            stop(m.id)
            failures.remove(m.id)
            return
        }
        val port = tcp!!.port!!
        if (port < 1024 || port > 65535) {
            throw BadRequestException("TCP 포트는 1024~65535 여야 합니다: $port")
        }
        val proto = try {
            protocols.specOf(UUID.fromString(tcp.protocolId!!.trim()), m.tenantId)
        } catch (e: Exception) {
            throw BadRequestException("TCP Mock 의 프로토콜을 찾을 수 없습니다: ${tcp.protocolId}")
        }
        val cur = listeners[m.id]
        if (cur != null && cur.port == port) {
            cur.tcp = tcp // 같은 포트 — 규칙/프로토콜/시크릿 환경만 핫스왑
            cur.protocol = proto
            cur.environment = spec.environment
            failures.remove(m.id)
            return
        }
        // 포트 변경/신규: **새 소켓을 먼저 확보한 뒤에야** 기존 리스너를 닫는다.
        // (구현: 먼저 stop 하면 바인딩 실패 시 @Transactional 롤백돼도 기존 포트 리스너가 닫힌 채 남아 mock 이 조용히 죽는다.)
        listeners.entries.find { it.key != m.id && it.value.port == port }?.let {
            throw BadRequestException("TCP 포트 $port 는 다른 mock 서버가 사용 중입니다.")
        }
        val ss = try {
            ServerSocket(port)
        } catch (e: IOException) {
            throw BadRequestException("TCP 포트 $port 바인딩 실패: ${e.message}") // 기존 리스너 그대로 — 롤백과 정합
        }
        if (cur != null) stop(m.id) // 새 소켓 확보 성공 후에만 기존 포트 리스너 종료
        val listener = Listener(m.id, m.tenantId, port, ss, tcp, proto, spec.environment)
        listeners[m.id] = listener
        failures.remove(m.id)
        Thread({ acceptLoop(listener) }, "tcp-mock-$port").apply {
            isDaemon = true
            start()
        }
        log.info("TCP mock 시작: slug={} port={}", m.slug, port)
    }

    fun stop(id: UUID) {
        failures.remove(id)
        listeners.remove(id)?.let {
            runCatching { it.socket.close() }
            log.info("TCP mock 중지: port={}", it.port)
        }
    }

    /**
     * TCP mock 생성 시 쓸 빈 포트 하나 — 현재 리스너가 쓰지 않고 실제 바인딩 가능한 포트를 [start]부터 탐색.
     * 새 TCP mock 을 만들자마자 켜도 포트 충돌로 create 가 롤백되지 않게 한다. 못 찾으면 start 반환(sync 가 실패 표면화).
     */
    fun pickFreePort(start: Int = 9091): Int {
        val used = listeners.values.mapTo(HashSet()) { it.port }
        var p = start.coerceIn(1024, 65535)
        while (p <= 65535) {
            if (p !in used) {
                try { ServerSocket(p).use { } ; return p } catch (e: IOException) { /* 사용 중 — 다음 */ }
            }
            p++
        }
        return start
    }

    private fun parseSpecQuiet(specJson: String?): MockSpec? {
        if (specJson.isNullOrBlank()) {
            return null
        }
        return try {
            json.mapper().readValue(specJson, MockSpec::class.java)
        } catch (e: Exception) {
            null // 깨진 spec 은 updateSpec 검증이 막는다 — 여기선 리스너만 안 연다
        }
    }

    // --- 수신 루프 ---

    private fun acceptLoop(l: Listener) {
        while (!l.socket.isClosed) {
            val sock = try {
                l.socket.accept()
            } catch (e: IOException) {
                return // close() 로 인한 정상 종료
            }
            Thread({ serve(l, sock) }, "tcp-mock-conn").apply {
                isDaemon = true
                start()
            }
        }
    }

    /** 연결 하나 — 세션에 위임(프레이밍 규약이라 같은 연결로 여러 전문). */
    private fun serve(l: Listener, sock: Socket) {
        sock.use {
            try {
                sock.soTimeout = 30_000
                val tcp = l.tcp // 연결 시작 시점 스냅샷 — 핫스왑이 규칙과 upstream 을 섞지 않게
                val secrets = secretProvider.secrets(l.tenantId, l.environment)
                val masks = SecretMasker.variants(secrets.values)
                val session = TcpMockSession(
                    l.protocol, tcp, ProtocolCodec.PluginLookup { transforms.codec(it) }, secrets,
                    { store.seqNext(l.mockId) }, { store.recordTcp(l.mockId, it) },
                    upstreamFactory = { openUpstream(tcp) },
                    mask = { s -> SecretMasker.mask(s, masks) ?: s },
                )
                session.serve(sock.getInputStream(), sock.getOutputStream()) {
                    runCatching { sock.setSoLinger(true, 0) }; runCatching { sock.close() }
                }
            } catch (e: SocketTimeoutException) {
                store.recordTcp(l.mockId, MockRuntimeStore.TcpLogEntry(
                    Instant.now(), "in", "none", null, emptyMap(), "", "", 0, null, null, "유휴 30초 경과 — 연결 종료", "warn",
                ))
            } catch (e: Exception) { /* 상대 종료/소켓 오류 — 연결만 닫는다 */ }
        }
    }

    private fun openUpstream(tcp: MockSpec.MockTcp): TcpMockSession.Upstream? {
        val target = tcp.upstream?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val ci = target.lastIndexOf(':'); if (ci <= 0) return null
        val host = target.substring(0, ci); val port = target.substring(ci + 1).toIntOrNull() ?: return null
        val t = tcp.timeoutMs?.takeIf { it > 0 } ?: 5000
        return try {
            val s = Socket()
            s.connect(InetSocketAddress(host, port), t)
            s.soTimeout = t
            TcpMockSession.Upstream(s.getInputStream(), s.getOutputStream()) { runCatching { s.close() } }
        } catch (e: IOException) {
            log.warn("upstream 연결 실패 {}: {}", target, e.message); null
        }
    }

    companion object {
        private val log = LoggerFactory.getLogger(TcpMockRegistry::class.java)
    }
}
