package com.flowlink.mock

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tcp.TcpBytes
import com.flowlink.core.domain.MockServer
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.execution.engine.SecretMasker
import com.flowlink.transform.FlowTransform
import com.flowlink.transform.TransformRegistry
import jakarta.annotation.PreDestroy
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

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
    private val repository: MockServerRepository,
    private val transforms: TransformRegistry,
    private val store: MockRuntimeStore,
    private val secretProvider: MockSecretProvider
) {

    private class Listener(
        val mockId: UUID,
        val tenantId: String,
        val port: Int,
        val socket: ServerSocket,
        @Volatile var tcp: MockSpec.MockTcp,
        @Volatile var codec: MockSpec.MockCodec?, // 서버 전문 코덱(요청 디코딩 → 매칭, 응답 렌더 → 인코딩)
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

    @PreDestroy
    fun stopAll() {
        listeners.keys.toList().forEach { stop(it) }
    }

    /**
     * mock 서버 한 개의 원하는 상태(spec.tcp × enabled)와 실제 리스너를 맞춘다.
     * 포트 바인딩 실패/다른 mock 과의 충돌은 BadRequestException — 저장 트랜잭션이 롤백된다.
     */
    fun sync(m: MockServer) {
        val spec = parseSpecQuiet(m.specJson)
        val tcp = spec?.tcp
        val want = m.isEnabled && tcp != null && tcp.enabled != false && tcp.port != null
        if (!want) {
            stop(m.id)
            failures.remove(m.id)
            return
        }
        val port = tcp!!.port!!
        if (port < 1024 || port > 65535) {
            throw BadRequestException("TCP 포트는 1024~65535 여야 합니다: $port")
        }
        val cur = listeners[m.id]
        if (cur != null && cur.port == port) {
            cur.tcp = tcp // 같은 포트 — 규칙/문자셋/코덱/시크릿 환경만 핫스왑
            cur.codec = spec?.codec
            cur.environment = spec?.environment
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
        val listener = Listener(m.id, m.tenantId, port, ss, tcp, spec?.codec, spec?.environment)
        listeners[m.id] = listener
        failures.remove(m.id)
        Thread({ acceptLoop(m.slug, listener) }, "tcp-mock-$port").apply {
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

    fun parseTcp(specJson: String?): MockSpec.MockTcp? = parseSpecQuiet(specJson)?.tcp

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
            // 이번 전문에서 실제로 받은 바이트 — 처리 도중 죽으면 이걸 요청 기록에 남긴다(널이면 아직 아무것도 안 받음).
            var received: ByteArray? = null
            var cs: Charset = charsetOf(l.tcp.charset)
            try {
                sock.soTimeout = SOCKET_TIMEOUT_MS
                val input = sock.getInputStream()
                val out = sock.getOutputStream()
                while (true) {
                    val tcp = l.tcp
                    cs = charsetOf(tcp.charset)
                    val prefixLen = tcp.prefixLength ?: 4
                    received = null
                    // 수신(프레이밍) 실패도 조용히 끊지 않고 받은 바이트 + 사유를 요청 기록에 남긴다.
                    val body: ByteArray = when (val frame = readFrame(input, prefixLen, tcp.prefixIncludesSelf == true, MAX_BODY)) {
                        is FrameResult.Closed -> return // 상대가 연결을 닫음(정상) — 기록 없음
                        is FrameResult.Bad -> {
                            log.warn("TCP mock 수신 실패(port={}, {}바이트): {}", l.port, frame.received.size, frame.reason)
                            recordFailure(l, cs, frame.received, 400, frame.reason)
                            return // 프레이밍이 깨지면 이후 전문 경계를 알 수 없다 — 연결 종료(기존 동작)
                        }
                        is FrameResult.Ok -> frame.body
                    }
                    received = body

                    // 요청 코덱(body/fields) → 레이아웃 슬라이싱 → contains + 필드 조건 매칭 → 응답 렌더(필드 코덱) → 응답 body 코덱.
                    // 엔진이 미리보기와 같은 경로. 시크릿({{ 이름@secret }})은 Mock 의 시크릿 환경으로 조회(10초 캐시).
                    val lookup: (String) -> FlowTransform? = { transforms.get(it).orElse(null) }
                    val secrets = secretProvider.secrets(l.tenantId, l.environment)
                    val processed = TcpMockEngine.process(tcp, l.codec, body, cs, store.seqNext(l.mockId), secrets, lookup)
                    val respBytes = processed.body
                    // 요청 기록 — HTTP 와 같은 journal(method="TCP", path=":포트"). 본문=디코딩 전문(시크릿 마스킹), 규칙 무매칭은 404 로 표기.
                    try {
                        val masks = SecretMasker.variants(secrets.values)
                        val rawText = String(body, cs)
                        val hasReqCodec = !l.codec?.request.isNullOrEmpty()
                        store.record(l.mockId, MockRuntimeStore.JournalEntry(
                            Instant.now(), "TCP", ":${l.port}", emptyMap(), mapOf("bytes" to body.size.toString(), "response-bytes" to respBytes.size.toString()),
                            (SecretMasker.mask(rawText, masks) ?: rawText).take(MockRuntimeStore.BODY_CAP),
                            processed.rule?.id, if (processed.rule != null) 200 else 404, 0, false,
                            if (hasReqCodec) (SecretMasker.mask(processed.reqText, masks) ?: processed.reqText).take(MockRuntimeStore.BODY_CAP) else null,
                        ))
                    } catch (e: Exception) { log.debug("TCP journal 기록 실패: {}", e.message) }
                    received = null // 성공 기록 완료 — 아래 전송 중 실패가 같은 전문을 두 번 남기지 않게
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
            } catch (e: MockCodec.CodecException) {
                log.warn("TCP mock 코덱 실패(port={}): {}", l.port, e.message) // 전문이 깨진 것 — 연결 종료 + 로그 + 기록
                recordFailure(l, cs, received ?: ByteArray(0), 500, "요청 코덱 실패: ${e.message}")
            } catch (e: Exception) {
                // 타임아웃/파싱 실패/상대 강제종료 — 연결만 닫는다(리스너는 계속).
                // 바이트를 이미 받았다면 조용히 사라지지 않게 기록한다(무엇이 왔고 왜 죽었는지).
                received?.let {
                    log.warn("TCP mock 처리 실패(port={}, {}바이트): {}", l.port, it.size, e.message ?: e.javaClass.simpleName)
                    recordFailure(l, cs, it, 500, e.message ?: e.javaClass.simpleName)
                }
            }
        }
    }

    /** 실패한 요청 1건을 기록(전문 기록에 ⚠ 로 보인다) — 기록 자체는 절대 밖으로 던지지 않는다. */
    private fun recordFailure(l: Listener, cs: Charset, bytes: ByteArray, status: Int, error: String) {
        try {
            val secrets = secretProvider.secrets(l.tenantId, l.environment)
            val masks = SecretMasker.variants(secrets.values)
            val raw = String(bytes, cs)
            val headers = LinkedHashMap<String, String>()
            headers["bytes"] = bytes.size.toString()
            if (bytes.isNotEmpty()) {
                headers["hex"] = TcpBytes.hexDump(TcpBytes.slice(bytes, 0, HEX_CAP)) + (if (bytes.size > HEX_CAP) " …" else "")
            }
            store.record(l.mockId, MockRuntimeStore.JournalEntry(
                Instant.now(), "TCP", ":${l.port}", emptyMap(), headers,
                (SecretMasker.mask(raw, masks) ?: raw).take(MockRuntimeStore.BODY_CAP),
                null, status, 0, false, null, error.take(ERROR_CAP),
            ))
        } catch (e: Exception) {
            log.debug("TCP 실패 기록 실패: {}", e.message)
        }
    }

    /** 전문 하나 읽기 결과 — 정상 종료(Closed)와 프레이밍 실패(Bad)를 구분해 실패만 기록/경고한다. */
    internal sealed class FrameResult {
        /** 본문(프리픽스 제외). */
        class Ok(val body: ByteArray) : FrameResult()
        /** 새 전문의 첫 바이트가 오기 전에 상대가 닫음/아무것도 안 옴 — 정상(기록 없음). */
        object Closed : FrameResult()
        /** 프레이밍 실패 — [received] 는 프리픽스 포함 실제로 받은 바이트(사용자가 뭐가 왔는지 볼 수 있게). */
        class Bad(val reason: String, val received: ByteArray) : FrameResult()
    }

    companion object {
        private val log = LoggerFactory.getLogger(TcpMockRegistry::class.java)
        private const val MAX_BODY = 1_000_000
        private const val SOCKET_TIMEOUT_MS = 30_000
        private const val HEX_CAP = 64   // 기록에 남길 hex 앞부분(바이트)
        private const val ERROR_CAP = 500 // 사유 문자열 상한

        /**
         * 전문 하나 수신 — 길이 프리픽스(ASCII 십진) 규약, [prefixLen] 0 이하면 EOF 까지(연결당 1전문).
         * 실패해도 **지금까지 받은 바이트를 그대로 돌려준다**(요청 기록에 남겨 원인을 보이게).
         * 사유 문구는 사용자가 바로 고칠 수 있는 설정 이름을 가리킨다.
         */
        @JvmStatic
        internal fun readFrame(input: InputStream, prefixLen: Int, includesSelf: Boolean, maxBody: Int): FrameResult {
            val got = ByteArrayOutputStream()
            if (prefixLen <= 0) {
                val f = fill(input, got, -1) // EOF 까지 = readAllBytes 와 같은 의미(타임아웃이면 받은 만큼 보존)
                val all = got.toByteArray()
                if (all.isEmpty()) {
                    return FrameResult.Closed // 아무것도 안 옴 — 정상 종료로 취급(빈 기록 잡음 방지)
                }
                if (f != Fill.FULL_EOF) {
                    return FrameResult.Bad(
                        "전문 ${all.size}바이트를 받았지만 상대가 연결을 닫지 않아 전문의 끝을 알 수 없습니다(${SOCKET_TIMEOUT_MS / 1000}초 대기) — 길이 프리픽스를 쓰는 상대라면 연결의 '길이 프리픽스(바이트)'를 설정하세요",
                        all,
                    )
                }
                return FrameResult.Ok(all)
            }
            val pf = fill(input, got, prefixLen)
            val pre = got.toByteArray()
            if (pre.isEmpty()) {
                return FrameResult.Closed // 상대가 연결을 닫음(정상) / 다음 전문 없이 유휴
            }
            if (pf != Fill.FULL) {
                return FrameResult.Bad(
                    "길이 프리픽스 ${prefixLen}바이트를 기다렸지만 ${pre.size}바이트만 도착했습니다 — 연결의 '길이 프리픽스(바이트)' 설정을 확인하세요",
                    pre,
                )
            }
            val text = String(pre, StandardCharsets.US_ASCII)
            val declared = text.trim().toIntOrNull()
                ?: return FrameResult.Bad(
                    "길이 프리픽스 ${prefixLen}바이트가 숫자가 아닙니다: '${TcpBytes.printable(pre, StandardCharsets.US_ASCII)}' — 연결의 '길이 프리픽스(바이트)' 설정을 확인하세요",
                    pre,
                )
            val len = if (includesSelf) declared - prefixLen else declared
            if (len < 0) {
                return FrameResult.Bad("선언 길이 $len 가 잘못됐습니다(프리픽스 $prefixLen, 선언 $declared) — 연결의 '프리픽스 포함 길이' 설정을 확인하세요", pre)
            }
            if (len > maxBody) {
                return FrameResult.Bad("본문 길이 $len 가 상한(${maxBody})을 넘습니다 — 길이 프리픽스 자릿수/규약이 맞는지 확인하세요", pre)
            }
            val bf = fill(input, got, len)
            val all = got.toByteArray()
            if (bf != Fill.FULL) {
                return FrameResult.Bad(
                    "본문 ${len}바이트를 기다렸지만 ${all.size - prefixLen}바이트만 도착했습니다 — 보낸 쪽의 길이 값이 자기 자신을 포함한다면 '프리픽스 포함 길이'를 켜세요",
                    all,
                )
            }
            return FrameResult.Ok(all.copyOfRange(prefixLen, all.size))
        }

        /** [fill] 결과 — 요청량 충족 / EOF(상대가 닫음) / 타임아웃. */
        private enum class Fill { FULL, FULL_EOF, TIMEOUT }

        /**
         * [want] 바이트(음수면 EOF 까지)를 [sink] 로 읽는다. 중간에 끊기거나 타임아웃이어도
         * 읽은 바이트는 [sink] 에 그대로 남는다(부분 수신 보존).
         */
        private fun fill(input: InputStream, sink: ByteArrayOutputStream, want: Int): Fill {
            val buf = ByteArray(8192)
            var remain = want
            while (want < 0 || remain > 0) {
                val cap = if (want < 0) buf.size else minOf(buf.size, remain)
                val n = try {
                    input.read(buf, 0, cap)
                } catch (e: SocketTimeoutException) {
                    return Fill.TIMEOUT
                } catch (e: EOFException) {
                    return Fill.FULL_EOF
                }
                if (n < 0) {
                    return Fill.FULL_EOF
                }
                sink.write(buf, 0, n)
                if (want >= 0) remain -= n
            }
            return Fill.FULL
        }

        /** 응답 템플릿 렌더({{req}}/{{req:o:l}}/{{req.필드}}/{{seq}}…) — 엔진 위임(기존 호출부·테스트 호환). */
        internal fun renderTemplate(template: String, reqBody: ByteArray, cs: Charset): String =
            TcpMockEngine.renderTemplate(template, reqBody, cs)

        internal fun charsetOf(name: String?): Charset = TcpMockEngine.charsetOf(name)
    }
}
