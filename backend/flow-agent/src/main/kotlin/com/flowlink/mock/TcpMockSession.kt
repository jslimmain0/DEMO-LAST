package com.flowlink.mock

import com.flowlink.common.tcp.TcpBytes
import com.flowlink.mock.MockSpec.MockTcp
import com.flowlink.mock.MockSpec.MockTcpFault
import com.flowlink.mock.MockSpec.MockTcpRule
import com.flowlink.protocol.Direction
import com.flowlink.protocol.Framer
import com.flowlink.protocol.ProtocolCodec
import com.flowlink.protocol.ProtocolSpec
import com.flowlink.protocol.TcpClient
import com.flowlink.protocol.ProtocolCompiler
import com.flowlink.execution.engine.SecretMasker
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.SocketTimeoutException
import java.time.Instant

/**
 * TCP Mock 연결 1개의 처리 — 스트림만 의존하는 순수 세션(리스너·테스트 공용).
 * 프레임 → 해석(헤더는 항상, 본문은 표가 있을 때) → 규칙 첫 매칭 → mock 응답(헤더 에코 + then.fields 템플릿, lenient 조립) 또는 proxy(upstream 왕복)
 * → 장애 주입 → 전송. 모든 단계를 [log] 로 남긴다([mock]/[proxy] 구분, 부분 수신 chunks, ⚠ 절단/길이 불일치, 에러 원본 hex).
 */
class TcpMockSession(
    private val spec: ProtocolSpec,
    private val tcp: MockTcp,
    private val plugins: ProtocolCodec.PluginLookup,
    private val secrets: Map<String, String>,
    private val seq: () -> Long,
    private val log: (MockRuntimeStore.TcpLogEntry) -> Unit,
    private val upstreamFactory: () -> Upstream?,
    private val mask: (String) -> String = { it },
    private val sleeper: (Long) -> Unit = { Thread.sleep(it) },
    private val env: Map<String, String> = emptyMap(),
    private val verifyResourceAccess: () -> Unit = {},
    private val onWaiting: () -> Unit = {},
    private val onFrame: () -> Unit = {},
    private val onPhase: (String, String?, Int?, Int) -> Unit = { _, _, _, _ -> },
    private val ackTimeout: (Int?) -> Unit = {},
) {
    /** 코덱 파라미터 안의 `{{ 이름@secret }}`·`{{ 키@env }}` — 이 Mock 의 환경 스코프로 푼다. */
    private val resolve: (String) -> String = MockSecretProvider.Scope(secrets, env).resolver()
    class Upstream(val input: InputStream, val output: OutputStream, val close: () -> Unit)

    private var upstream: Upstream? = null
    private val cs = spec.charset()
    private var secretDerived = SecretMasker.usesSecrets(secrets.values, spec, tcp)

    /** 연결 하나 — EOF/프레임 오류/reset 까지 프레임을 처리한다. onReset 은 RST 로 끊을 때 호출. */
    fun serve(input: InputStream, output: OutputStream, onReset: () -> Unit) {
        if (spec.schemaVersion == 2) { serveV2(input, output, onReset); return }
        try {
            while (true) {
                onWaiting()
                val frame = try { Framer.readFrame(input, spec, Direction.SEND) ?: return } catch (e: Framer.FrameException) {
                    val raw = e.raw ?: ByteArray(0)
                    log(entry("in", "none", null, emptyMap(), raw, null, null, e.message, "error")); return
                }
                onFrame()
                if (!handleFrame(frame, input, output, onReset)) return
            }
        } catch (_: SocketTimeoutException) {
            log(entry("in", "none", null, emptyMap(), ByteArray(0), null, null, "유휴 기한 경과 — 연결 종료", "warn"))
        } catch (e: IOException) {
            log(entry("in", "none", null, emptyMap(), ByteArray(0), null, null, "TCP 연결 종료: ${e.message}", "error"))
        } finally {
            upstream?.let { runCatching { it.close() } }; upstream = null
        }
    }

    private fun serveV2(input: InputStream, output: OutputStream, onReset: () -> Unit) {
        val plan = ProtocolCompiler.compile(spec)
        var phase = "REQUEST"
        var transaction: ProtocolSpec.Transaction? = null
        var expected: Int? = null
        var actual = 0
        var phaseStart = System.nanoTime()
        var ruleId: String? = null
        var phaseBytes = ByteArray(0)
        fun begin(next: String, length: Int? = null) {
            phase = next; expected = length; actual = 0; phaseBytes = ByteArray(0); phaseStart = System.nanoTime()
            onPhase(phase, transaction?.key, expected, actual)
        }
        fun record(dir: String, status: String, fields: Map<String, String> = emptyMap(), mode: String? = null, code: String? = null) {
            log(entry(dir, "mock", transaction?.key, fields, phaseBytes, null, ruleId, if (code != null) "$phase: $code" else phase, if (status == "FAILED") "error" else "info").copy(
                transactionKey = transaction?.key, phase = phase, role = "mock", direction = if (dir == "in") "RECEIVE" else if (dir == "out") "SEND" else null,
                expectedBytes = expected, actualBytes = actual, validationMode = mode, errorCode = code, durationMs = (System.nanoTime() - phaseStart) / 1_000_000, status = status))
            onPhase(phase, transaction?.key, expected, actual)
        }
        try {
            while (true) {
                transaction = null; ruleId = null
                onWaiting(); begin("REQUEST")
                val frame = Framer.readFrame(input, spec, Direction.SEND) { key, size ->
                    transaction = key?.let(plan::transaction); expected = size
                    onPhase("REQUEST", key, size, spec.headerLen())
                } ?: return
                onFrame(); actual = frame.bytes.size; phaseBytes = frame.bytes
                val selected = frame.transactionKey?.let(plan::transaction) ?: plan.select(ProtocolCompiler.header(spec, frame.bytes, plugins, resolve))
                transaction = selected
                expected = plan.effectiveSpec(selected).framing?.fixedLength
                verifyResourceAccess()
                val request = ProtocolCompiler.parse(spec, frame.bytes, transactionKey = selected.key, plugins = plugins, resolve = resolve)
                val rule = TcpMockRules.match(tcp.rulesOrEmpty(), request.values, resolve)
                    ?: throw ProtocolCompiler.ProtocolFailure("NO_MATCHING_RULE", "tcp.rules", "매칭되는 Mock 업무 규칙이 없습니다.")
                ruleId = rule.id; record("in", "SUCCEEDED", request.values)
                val requestAck = selected.requestAck
                begin("REQUEST_ACK", requestAck?.let { ProtocolCompiler.ackLength(spec, it) })
                if (requestAck == null) record("none", "SKIPPED") else {
                    phaseBytes = ProtocolCompiler.assembleAck(spec, requestAck, request.values, emptyMap(), plugins, resolve).bytes
                    output.write(phaseBytes); output.flush(); actual = phaseBytes.size
                    record("out", "SUCCEEDED", mode = requestAck.send?.kind)
                }
                begin("RESPONSE", plan.effectiveSpec(selected).responseFraming?.fixedLength)
                val fault = rule.fault
                if (fault?.drop == true || fault?.reset == true) {
                    if ((fault.delayMs ?: 0) > 0) sleeper(fault.delayMs!!.toLong())
                    record("out", "FAILED", code = if (fault.drop == true) "FAULT_DROP" else "FAULT_RESET")
                    if (fault.reset == true) { onReset(); return }
                    if (spec.transport?.connectionOr() != "execution") return
                    continue
                }
                val response: ByteArray
                val responseFields: Map<String, String>
                if (rule.isProxy()) {
                    val upstream = upstream ?: upstreamFactory()?.also { upstream = it } ?: throw IOException("upstream 연결 실패")
                    val exchange = TcpClient.exchange(upstream.input, upstream.output, frame.bytes, spec, plugins = plugins, resolve = resolve)
                    response = exchange.response.bytes
                    responseFields = ProtocolCompiler.parse(spec, response, transactionKey = selected.key, phase = "response", requestFields = request.values, plugins = plugins, resolve = resolve).values
                } else {
                    val headerNames = spec.headerOrEmpty().map { it.nameOrEmpty() }.toSet()
                    val fields = TcpMockRules.responseFields(request.values.filterKeys { it in headerNames }, rule.thenFields(), MockContext(seq = seq(), secrets = secrets, tcpFields = request.values, env = env), true)
                    val encoded = ProtocolCompiler.assemble(spec, values = fields, transactionKey = selected.key, phase = "response", requestFields = request.values, plugins = plugins, resolve = resolve)
                    response = encoded.bytes; responseFields = encoded.values
                }
                phaseBytes = response
                if (!writeWithFault(response, rule, output, onReset, "mock", plan.effectiveSpec(selected))) return
                actual = response.size; record("out", "SUCCEEDED", responseFields)
                val responseAck = selected.responseAck
                begin("RESPONSE_ACK", responseAck?.let { ProtocolCompiler.ackLength(spec, it) })
                if (responseAck == null) record("none", "SKIPPED") else {
                    ackTimeout(responseAck.timeoutMs)
                    try { phaseBytes = TcpClient.receiveAck(input, spec, responseAck, request.values, responseFields, plugins, resolve); actual = phaseBytes.size }
                    finally { ackTimeout(null) }
                    record("in", "SUCCEEDED", mode = responseAck.receive?.kind)
                }
                begin("COMPLETE"); record("none", "SUCCEEDED")
                if (spec.transport?.connectionOr() != "execution") return
            }
        } catch (e: Exception) {
            if (e is TcpClient.AckException) { actual = e.bytes.size; phaseBytes = e.bytes; expected = e.expectedBytes }
            if (e is Framer.FrameException) { phaseBytes = e.raw ?: ByteArray(0); actual = phaseBytes.size; expected = e.expectedBytes ?: expected }
            val code = when (e) { is TcpClient.AckException -> e.code; is ProtocolCompiler.ProtocolFailure -> e.code; is SocketTimeoutException -> if (phase.endsWith("ACK")) "ACK_TIMEOUT" else "FRAME_TIMEOUT"; is Framer.FrameException -> e.code ?: "FRAME_LENGTH_MISMATCH"; else -> "TRANSPORT_ERROR" }
            record(if (phase == "REQUEST" || phase == "RESPONSE_ACK") "in" else "out", "FAILED", mode = if (phase == "RESPONSE_ACK") transaction?.responseAck?.receive?.kind else null, code = code)
        } finally { upstream?.let { runCatching { it.close() } }; upstream = null; ackTimeout(null) }
    }

    /** 프레임 하나 처리. false = 연결을 끊어야 함(reset). */
    private fun handleFrame(frame: Framer.Frame, input: InputStream, output: OutputStream, onReset: () -> Unit): Boolean {
        try { verifyResourceAccess() } catch (_: Exception) {
            log(entry("in", "none", null, emptyMap(), frame.bytes, frame.chunks, null, "중앙 Mock 연결 계정을 확인하지 못해 연결을 종료합니다.", "error", frame.partial))
            return false
        }
        val decoded = try { ProtocolCodec.decode(spec, frame.bytes, Direction.SEND, plugins, resolve = resolve) } catch (e: ProtocolCodec.ProtocolException) {
            log(entry("in", "none", null, emptyMap(), frame.bytes, frame.chunks, null, e.message, "error", frame.partial)); return true
        } catch (e: Exception) { // 코덱 플러그인 등에서 튀어나온 예외 — 연결을 조용히 죽이지 않고 로그 행으로
            log(entry("in", "none", null, emptyMap(), frame.bytes, frame.chunks, null, "처리 오류: ${e.message ?: e}", "error", frame.partial)); return true
        }
        val values = decoded.values()
        val rule = match(tcp.rulesOrEmpty(), values)
        val source = when { rule == null -> "none"; rule.isProxy() -> "proxy"; else -> "mock" }
        val notes = ArrayList(decoded.warnings)
        if (decoded.messageKey == null) notes += "본문 스키마 없음 — raw ${decoded.rawBody.size} B"
        if (rule == null) notes += "매칭 규칙 없음 — 응답 없음"
        log(entry("in", source, decoded.disc ?: decoded.messageKey, values, frame.bytes, frame.chunks, rule?.id, notes.joinToString(" · ").ifEmpty { null }, if (rule == null || decoded.warnings.isNotEmpty()) "warn" else "info", frame.partial))
        TcpClient.ackBytes(spec.transport?.requestAckHex)?.let {
            output.write(it); output.flush()
            log(entry("out", source, null, emptyMap(), it, null, rule?.id, "요청 ACK", "info"))
        }
        if (rule == null) return true
        // 응답을 만들기 전에 끊는 장애부터 — then 이 없거나 upstream 이 죽어도 drop/reset 은 그대로 동작해야 한다
        val f = rule.fault
        if (f?.drop == true || f?.reset == true) {
            val delay = f.delayMs ?: 0
            if (delay > 0) sleeper(delay.toLong())
            if (f.drop == true) { log(entry("out", source, null, emptyMap(), ByteArray(0), null, rule.id, "drop — 무응답(연결 유지)", "warn")); return true }
            onReset(); log(entry("out", source, null, emptyMap(), ByteArray(0), null, rule.id, "reset — 연결 강제 종료(RST)", "warn")); return false
        }
        if (rule.then == null) { log(entry("out", source, null, emptyMap(), ByteArray(0), null, rule.id, "then 없음 — 응답 없음", "warn")); return true }
        val resp = if (rule.isProxy()) proxy(frame, rule) else mockResponse(rule, decoded)
        resp ?: return !rule.isProxy()
        if (!writeWithFault(resp, rule, output, onReset, source)) return false
        TcpClient.ackBytes(spec.transport?.responseAckHex)?.let {
            val received = TcpClient.readAck(input, it, "응답 ACK")
            log(entry("in", source, null, emptyMap(), received, null, rule.id, "응답 ACK", "info"))
        }
        return true
    }

    // ---------- 규칙 ----------

    private fun match(rules: List<MockTcpRule>, values: Map<String, String>): MockTcpRule? =
        TcpMockRules.match(rules, values, resolve)

    // ---------- mock 응답 ----------

    private fun mockResponse(rule: MockTcpRule, decoded: ProtocolCodec.Decoded): ByteArray? {
        val ctx = MockContext(seq = seq(), secrets = secrets, tcpFields = decoded.values(), env = env)
        val fields = LinkedHashMap<String, String>(decoded.header) // 헤더 에코(길이는 자동)
        for ((k, tpl) in rule.thenFields()) fields[k] = MockTemplate.render(tpl, ctx)
        val disc = if (spec.hasDiscriminator()) fields[spec.discriminator!!.trim()] else null
        val msg = spec.lookup(disc, Direction.RECV) ?: run {
            log(entry("out", "mock", disc, fields, ByteArray(0), null, rule.id, "응답 전문 '${disc ?: Direction.RECV.key}' 정의가 없습니다.", "error")); return null
        }
        val enc = try { ProtocolCodec.encode(spec, msg.keyOrEmpty(), fields, Direction.SEND, plugins, lenient = true, resolve = resolve, frameDirection = Direction.RECV) } catch (e: ProtocolCodec.ProtocolException) {
            log(entry("out", "mock", disc, fields, ByteArray(0), null, rule.id, e.message, "error")); return null
        } catch (e: Exception) {
            log(entry("out", "mock", disc, fields, ByteArray(0), null, rule.id, "처리 오류: ${e.message ?: e}", "error")); return null
        }
        log(entry("out", "mock", msg.keyOrEmpty(), fields, enc.bytes, null, rule.id, enc.warnings.joinToString(" · ").ifEmpty { null }, if (enc.warnings.isEmpty()) "info" else "warn"))
        return enc.bytes
    }

    // ---------- proxy ----------

    private fun proxy(frame: Framer.Frame, rule: MockTcpRule): ByteArray? {
        val up = upstream ?: upstreamFactory()?.also { upstream = it }
        if (up == null) {
            log(entry("out", "proxy", null, emptyMap(), ByteArray(0), null, rule.id, "upstream 연결 실패/미지정(${tcp.upstream ?: "없음"})", "error")); return null
        }
        return try {
            val exchange = TcpClient.exchange(up.input, up.output, frame.bytes, spec)
            exchange.requestAck?.let { log(entry("in", "proxy", null, emptyMap(), it, null, rule.id, "upstream 요청 ACK", "info")) }
            exchange.responseAck?.let { log(entry("out", "proxy", null, emptyMap(), it, null, rule.id, "upstream 응답 ACK", "info")) }
            val r = exchange.response
            val d = runCatching { ProtocolCodec.decode(spec, r.bytes, Direction.RECV, plugins, resolve = resolve) }.getOrNull()
            log(entry("out", "proxy", d?.disc ?: d?.messageKey, d?.values() ?: emptyMap(), r.bytes, r.chunks, rule.id, d?.warnings?.joinToString(" · ")?.ifEmpty { null }, if (d == null || d.warnings.isNotEmpty()) "warn" else "info", r.partial))
            r.bytes
        } catch (e: Exception) {
            log(entry("out", "proxy", null, emptyMap(), (e as? Framer.FrameException)?.raw ?: ByteArray(0), null, rule.id, "upstream 오류: ${e.message}", "error"))
            runCatching { up.close() }; upstream = null
            null
        }
    }

    // ---------- 장애 주입 + 전송 ----------

    private fun writeWithFault(bytes: ByteArray, rule: MockTcpRule, output: OutputStream, onReset: () -> Unit, source: String, protocol: ProtocolSpec = spec): Boolean {
        val f: MockTcpFault? = rule.fault
        val delay = f?.delayMs ?: 0
        if (delay > 0) sleeper(delay.toLong())
        var b = bytes
        if (f?.corruptLength == true) {
            if (protocol.framingMode(Direction.RECV) != "length" || protocol.lengthFieldDef() == null) {
                log(entry("out", source, null, emptyMap(), ByteArray(0), null, rule.id, "corrupt-length 불가 — 응답이 길이 필드 프레이밍을 사용하지 않습니다.", "warn"))
            } else {
                // binary 길이 필드는 +7 이 표현 범위를 넘을 수 있다 — 그땐 원본 그대로 보내고 경고만 남긴다.
                val declared = ProtocolCodec.declaredLength(protocol, b.size, Direction.RECV) + 7
                try {
                    b = ProtocolCodec.withLength(protocol, b, declared)
                    log(entry("out", source, null, emptyMap(), b, null, rule.id, "corrupt-length — 길이 필드에 $declared", "warn"))
                } catch (e: ProtocolCodec.ProtocolException) {
                    log(entry("out", source, null, emptyMap(), b, null, rule.id, "corrupt-length 불가: ${e.message}", "warn"))
                } catch (e: Exception) {
                    log(entry("out", source, null, emptyMap(), b, null, rule.id, "처리 오류: ${e.message ?: e}", "error"))
                }
            }
        }
        val split = f?.splitAt
        if (split != null && split in 1 until b.size) {
            output.write(b, 0, split); output.flush(); sleeper(300L); output.write(b, split, b.size - split)
            log(entry("out", source, null, emptyMap(), ByteArray(0), listOf(split, b.size - split), rule.id, "split — ${split}B 보내고 300ms 뒤 나머지", "warn", true))
        } else {
            if (split != null) log(entry("out", source, null, emptyMap(), ByteArray(0), null, rule.id, "split 무시 — splitAt=$split, 전문 ${b.size}B", "warn"))
            output.write(b)
        }
        output.flush()
        return true
    }

    // ---------- 로그 ----------

    private fun entry(dir: String, source: String, key: String?, fields: Map<String, String>, bytes: ByteArray, chunks: List<Int>?, ruleId: String?, note: String?, level: String, partial: Boolean = false): MockRuntimeStore.TcpLogEntry {
        // 큰 전문은 앞부분만 로그에 싣는다(행 200개 × 전문 크기가 힙을 먹지 않게) — bytes 는 실제 크기 그대로.
        val shown = if (bytes.size > MockRuntimeStore.BODY_CAP) bytes.copyOf(MockRuntimeStore.BODY_CAP) else bytes
        val raw = TcpBytes.decodeEscaped(shown, cs).map { if (it.code < 0x20) '.' else it }.joinToString("")
        secretDerived = secretDerived || SecretMasker.usesSecrets(secrets.values, fields, raw)
        val conceal = secretDerived || (level == "error" && secrets.isNotEmpty() && ProtocolCompiler.pluginRefs(spec).isNotEmpty())
        val text = if (conceal) "***" else mask(raw)
        val hidden = text != raw // 시크릿이 전문에 실려 있었다 — hex 로 원문이 새지 않게 통째로 뺀다
        val notes = ArrayList<String>()
        note?.let { notes += if (conceal) "시크릿 참조가 있어 상세 내용을 숨겼습니다." else mask(it) }
        if (shown.size < bytes.size) notes += "앞 ${MockRuntimeStore.BODY_CAP}B만 표시(전체 ${bytes.size}B)"
        if (hidden) notes += "hex 생략(시크릿 마스킹)"
        return MockRuntimeStore.TcpLogEntry(
            Instant.now(), dir, source, key, fields.mapValues { if (conceal) "***" else mask(it.value) },
            text, if (hidden) "" else TcpBytes.hexDump(shown), bytes.size, chunks, ruleId,
            notes.joinToString(" · ").ifEmpty { null }, level, partial,
        )
    }
}
