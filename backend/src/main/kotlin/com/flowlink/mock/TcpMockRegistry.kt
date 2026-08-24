package com.flowlink.mock

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.core.domain.MockServer
import com.flowlink.core.repository.MockServerRepository
import jakarta.annotation.PreDestroy
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import java.io.IOException
import java.io.InputStream
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.regex.Pattern

/**
 * TCP mock 리스너 수명 관리 — mock 서버 spec 의 tcp 섹션이 있고 enabled 면 지정 포트에
 * ServerSocket 을 열어 고정길이 전문(길이 프리픽스)을 받고 규칙 매칭 응답을 돌려준다.
 *
 * <p>HTTP mock(/mock/{slug}/…)과 동일한 "테스트 도구" 전제 — 무인증·무상태.
 * 리스너는 mock 저장/토글/삭제(MockServerService)와 앱 기동 시(ApplicationReady) 동기화된다.
 * 포트 바인딩 실패·충돌은 저장 시점에 BadRequest 로 표면화(조용한 실패 방지).
 */
@Component
class TcpMockRegistry(
    private val json: JsonService,
    private val repository: MockServerRepository
) {

    private class Listener(
        val port: Int,
        val socket: ServerSocket,
        @Volatile var tcp: MockSpec.MockTcp
    )

    private val listeners = ConcurrentHashMap<UUID, Listener>() // mock 서버 id → 리스너

    /** 현재 열려 있는 TCP mock 포트 목록(기동 요약 로그·상태 점검용). */
    fun activePorts(): List<Int> = listeners.values.map { it.port }.sorted()

    @EventListener(ApplicationReadyEvent::class)
    fun startAll() {
        for (m in repository.findAll()) {
            try {
                sync(m)
            } catch (e: Exception) {
                // 기동 시 실패(포트 선점 등)는 로그만 — 서버 전체를 죽이지 않는다
                log.warn("TCP mock 기동 실패(slug={}): {}", m.slug, e.message)
            }
        }
    }

    @PreDestroy
    fun stopAll() {
        listeners.keys.toList().forEach { stop(it) }
    }

    /**
     * mock 서버 한 개의 원하는 상태(spec.tcp × enabled)와 실제 리스너를 맞춘다.
     * 포트 바인딩 실패/다른 mock 과의 충돌은 BadRequestException — 저장 트랜잭션이 롤백된다.
     */
    fun sync(m: MockServer) {
        val tcp = parseTcp(m.specJson)
        val want = m.isEnabled && tcp != null && tcp.enabled != false && tcp.port != null
        if (!want) {
            stop(m.id)
            return
        }
        val port = tcp!!.port!!
        if (port < 1024 || port > 65535) {
            throw BadRequestException("TCP 포트는 1024~65535 여야 합니다: $port")
        }
        val cur = listeners[m.id]
        if (cur != null && cur.port == port) {
            cur.tcp = tcp // 같은 포트 — 규칙/문자셋만 핫스왑
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
        val listener = Listener(port, ss, tcp)
        listeners[m.id] = listener
        Thread({ acceptLoop(m.slug, listener) }, "tcp-mock-$port").apply {
            isDaemon = true
            start()
        }
        log.info("TCP mock 시작: slug={} port={}", m.slug, port)
    }

    fun stop(id: UUID) {
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

    fun parseTcp(specJson: String?): MockSpec.MockTcp? {
        if (specJson.isNullOrBlank()) {
            return null
        }
        return try {
            json.mapper().readValue(specJson, MockSpec::class.java)?.tcp
        } catch (e: Exception) {
            null // 깨진 spec 은 updateSpec 검증이 막는다 — 여기선 리스너만 안 연다
        }
    }

    // --- 수신 루프 ---

    private fun acceptLoop(slug: String, l: Listener) {
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

    /** 연결 하나 처리 — 프리픽스 규약이면 같은 연결로 여러 전문을 주고받을 수 있다. */
    private fun serve(l: Listener, sock: Socket) {
        sock.use {
            try {
                sock.soTimeout = 30_000
                val input = sock.getInputStream()
                val out = sock.getOutputStream()
                while (true) {
                    val tcp = l.tcp
                    val cs = charsetOf(tcp.charset)
                    val prefixLen = tcp.prefixLength ?: 4
                    val body: ByteArray = if (prefixLen > 0) {
                        val pre = input.readNBytes(prefixLen)
                        if (pre.isEmpty()) {
                            return // 상대가 연결을 닫음
                        }
                        if (pre.size < prefixLen) {
                            return
                        }
                        val declared = String(pre, StandardCharsets.US_ASCII).trim().toIntOrNull() ?: return
                        val len = if (tcp.prefixIncludesSelf == true) declared - prefixLen else declared
                        if (len < 0 || len > MAX_BODY) {
                            return
                        }
                        readN(input, len) ?: return
                    } else {
                        val all = input.readAllBytes()
                        if (all.isEmpty()) {
                            return
                        }
                        all
                    }

                    val text = String(body, cs)
                    val rule = l.tcp.rulesOrEmpty().firstOrNull { r ->
                        r.contains.isNullOrEmpty() || text.contains(r.contains)
                    }
                    val respBytes = renderTemplate(rule?.response ?: "", body, cs).toByteArray(cs)
                    if (prefixLen > 0) {
                        val declared = if (tcp.prefixIncludesSelf == true) respBytes.size + prefixLen else respBytes.size
                        out.write(String.format("%0${prefixLen}d", declared).toByteArray(StandardCharsets.US_ASCII))
                    }
                    out.write(respBytes)
                    out.flush()
                    if (prefixLen <= 0) {
                        return // EOF 모드는 연결당 1전문
                    }
                }
            } catch (e: Exception) {
                // 타임아웃/파싱 실패/상대 강제종료 — 연결만 닫는다(리스너는 계속)
            }
        }
    }

    companion object {
        private val log = LoggerFactory.getLogger(TcpMockRegistry::class.java)
        private const val MAX_BODY = 1_000_000

        // {{req}} = 요청 전문 전체, {{req:오프셋:길이}} = 요청 바이트 슬라이스(디코딩해 삽입)
        private val REQ_TOKEN: Pattern = Pattern.compile("\\{\\{\\s*req(?::(\\d+):(\\d+))?\\s*}}")

        /** 응답 템플릿 렌더 — 요청 전문(바이트)을 참조하는 에코 응답을 만들 수 있다. */
        internal fun renderTemplate(template: String, reqBody: ByteArray, cs: Charset): String {
            if (template.isEmpty() || !template.contains("{{")) {
                return template
            }
            val m = REQ_TOKEN.matcher(template)
            val sb = StringBuilder()
            while (m.find()) {
                val rep = if (m.group(1) == null) {
                    String(reqBody, cs)
                } else {
                    val off = m.group(1).toInt()
                    val len = m.group(2).toInt()
                    val from = minOf(off, reqBody.size)
                    val to = minOf(off + len, reqBody.size)
                    String(reqBody.copyOfRange(from, to), cs)
                }
                m.appendReplacement(sb, java.util.regex.Matcher.quoteReplacement(rep))
            }
            m.appendTail(sb)
            return sb.toString()
        }

        internal fun charsetOf(name: String?): Charset {
            if (name.isNullOrBlank()) {
                return Charset.forName("EUC-KR")
            }
            return try {
                Charset.forName(name.trim())
            } catch (e: Exception) {
                Charset.forName("EUC-KR")
            }
        }

        private fun readN(input: InputStream, n: Int): ByteArray? {
            val buf = input.readNBytes(n)
            return if (buf.size < n) null else buf
        }
    }
}
