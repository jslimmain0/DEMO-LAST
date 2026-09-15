package com.flowlink.mock

import com.flowlink.common.tcp.TcpBytes
import com.flowlink.mock.MockSpec.MockTcp
import com.flowlink.mock.MockSpec.MockTcpCond
import com.flowlink.mock.MockSpec.MockTcpFault
import com.flowlink.mock.MockSpec.MockTcpRule
import com.flowlink.protocol.Direction
import com.flowlink.protocol.Framer
import com.flowlink.protocol.ProtocolCodec
import com.flowlink.protocol.ProtocolSpec
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.time.Instant
import java.util.Locale
import java.util.regex.Pattern

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
) {
    class Upstream(val input: InputStream, val output: OutputStream, val close: () -> Unit)

    private var upstream: Upstream? = null
    private val cs = spec.charset()

    /** 연결 하나 — EOF/프레임 오류/reset 까지 프레임을 처리한다. onReset 은 RST 로 끊을 때 호출. */
    fun serve(input: InputStream, output: OutputStream, onReset: () -> Unit) {
        try {
            while (true) {
                val frame = try { Framer.readFrame(input, spec) ?: return } catch (e: Framer.FrameException) {
                    val raw = e.raw ?: ByteArray(0)
                    log(entry("in", "none", null, emptyMap(), raw, null, null, e.message, "error")); return
                }
                if (!handleFrame(frame, output, onReset)) return
            }
        } finally {
            upstream?.let { runCatching { it.close() } }; upstream = null
        }
    }

    /** 프레임 하나 처리. false = 연결을 끊어야 함(reset). */
    fun handleFrame(frame: Framer.Frame, output: OutputStream, onReset: () -> Unit): Boolean {
        val decoded = try { ProtocolCodec.decode(spec, frame.bytes, Direction.SEND, plugins) } catch (e: ProtocolCodec.ProtocolException) {
            log(entry("in", "none", null, emptyMap(), frame.bytes, frame.chunks, null, e.message, "error")); return true
        }
        val values = decoded.values()
        val rule = match(tcp.rulesOrEmpty(), values)
        val source = when { rule == null -> "none"; rule.isProxy() -> "proxy"; else -> "mock" }
        val notes = ArrayList(decoded.warnings)
        if (decoded.messageKey == null) notes += "본문 스키마 없음 — raw ${decoded.rawBody.size} B"
        if (rule == null) notes += "매칭 규칙 없음 — 응답 없음"
        log(entry("in", source, decoded.disc ?: decoded.messageKey, values, frame.bytes, frame.chunks, rule?.id, notes.joinToString(" · ").ifEmpty { null }, if (rule == null || decoded.warnings.isNotEmpty()) "warn" else "info"))
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
        resp ?: return true
        return writeWithFault(resp, rule, output, onReset, source)
    }

    // ---------- 규칙 ----------

    private fun match(rules: List<MockTcpRule>, values: Map<String, String>): MockTcpRule? =
        rules.firstOrNull { r -> r.whenOrEmpty().all { pass(it, values) } }

    private fun pass(c: MockTcpCond, values: Map<String, String>): Boolean {
        val field = c.field?.trim().orEmpty()
        if (field.isEmpty()) return true // 편집 중 미완성 조건
        val actual = values[field]?.trim() ?: return false
        val v = c.value ?: ""
        return when (c.op?.lowercase(Locale.ROOT) ?: "eq") {
            "eq" -> actual == v.trim()
            "ne" -> actual != v.trim()
            "contains" -> actual.contains(v)
            "startswith" -> actual.startsWith(v.trim())
            "endswith" -> actual.endsWith(v.trim())
            "regex" -> try { Pattern.compile(v).matcher(actual).find() } catch (e: Exception) { false }
            "exists" -> actual.isNotEmpty()
            else -> actual == v.trim()
        }
    }

    // ---------- mock 응답 ----------

    private fun mockResponse(rule: MockTcpRule, decoded: ProtocolCodec.Decoded): ByteArray? {
        val ctx = MockContext(seq = seq(), secrets = secrets, tcpFields = decoded.values())
        val fields = LinkedHashMap<String, String>(decoded.header) // 헤더 에코(길이는 자동)
        for ((k, tpl) in rule.thenFields()) fields[k] = MockTemplate.render(tpl, ctx)
        val disc = if (spec.hasDiscriminator()) fields[spec.discriminator!!.trim()] else null
        val msg = spec.lookup(disc, Direction.RECV) ?: run {
            log(entry("out", "mock", disc, fields, ByteArray(0), null, rule.id, "응답 전문 '${disc ?: Direction.RECV.key}' 정의가 없습니다.", "error")); return null
        }
        val enc = try { ProtocolCodec.encode(spec, msg.keyOrEmpty(), fields, Direction.SEND, plugins, lenient = true) } catch (e: ProtocolCodec.ProtocolException) {
            log(entry("out", "mock", disc, fields, ByteArray(0), null, rule.id, e.message, "error")); return null
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
            up.output.write(frame.bytes); up.output.flush()
            val r = Framer.readFrame(up.input, spec) ?: throw IOException("upstream 이 응답 없이 연결을 닫았습니다.")
            val d = runCatching { ProtocolCodec.decode(spec, r.bytes, Direction.RECV, plugins) }.getOrNull()
            log(entry("out", "proxy", d?.disc ?: d?.messageKey, d?.values() ?: emptyMap(), r.bytes, r.chunks, rule.id, d?.warnings?.joinToString(" · ")?.ifEmpty { null }, if (d == null || d.warnings.isNotEmpty()) "warn" else "info"))
            r.bytes
        } catch (e: Exception) {
            log(entry("out", "proxy", null, emptyMap(), (e as? Framer.FrameException)?.raw ?: ByteArray(0), null, rule.id, "upstream 오류: ${e.message}", "error"))
            runCatching { up.close() }; upstream = null
            null
        }
    }

    // ---------- 장애 주입 + 전송 ----------

    private fun writeWithFault(bytes: ByteArray, rule: MockTcpRule, output: OutputStream, onReset: () -> Unit, source: String): Boolean {
        val f: MockTcpFault? = rule.fault
        val delay = f?.delayMs ?: 0
        if (delay > 0) sleeper(delay.toLong())
        var b = bytes
        if (f?.corruptLength == true) {
            // binary 길이 필드는 +7 이 표현 범위를 넘을 수 있다 — 그땐 원본 그대로 보내고 경고만 남긴다.
            val declared = ProtocolCodec.declaredLength(spec, b.size) + 7
            try {
                b = ProtocolCodec.withLength(spec, b, declared)
                log(entry("out", source, null, emptyMap(), b, null, rule.id, "corrupt-length — 길이 필드에 $declared", "warn"))
            } catch (e: ProtocolCodec.ProtocolException) {
                log(entry("out", source, null, emptyMap(), b, null, rule.id, "corrupt-length 불가: ${e.message}", "warn"))
            }
        }
        val split = f?.splitAt
        if (split != null && split in 1 until b.size) {
            output.write(b, 0, split); output.flush(); sleeper(300L); output.write(b, split, b.size - split)
            log(entry("out", source, null, emptyMap(), ByteArray(0), listOf(split, b.size - split), rule.id, "split — ${split}B 보내고 300ms 뒤 나머지", "warn"))
        } else {
            if (split != null) log(entry("out", source, null, emptyMap(), ByteArray(0), null, rule.id, "split 무시 — splitAt=$split, 전문 ${b.size}B", "warn"))
            output.write(b)
        }
        output.flush()
        return true
    }

    // ---------- 로그 ----------

    private fun entry(dir: String, source: String, key: String?, fields: Map<String, String>, bytes: ByteArray, chunks: List<Int>?, ruleId: String?, note: String?, level: String): MockRuntimeStore.TcpLogEntry {
        val raw = TcpBytes.decodeEscaped(bytes, cs).map { if (it.code < 0x20) '.' else it }.joinToString("")
        val text = mask(raw)
        val hidden = text != raw // 시크릿이 전문에 실려 있었다 — hex 로 원문이 새지 않게 통째로 뺀다
        val n = note?.let { mask(it) }
        return MockRuntimeStore.TcpLogEntry(
            Instant.now(), dir, source, key, fields.mapValues { mask(it.value) },
            text, if (hidden) "" else TcpBytes.hexDump(bytes), bytes.size, chunks, ruleId,
            if (hidden) (n?.plus(" · ") ?: "") + "hex 생략(시크릿 마스킹)" else n, level,
        )
    }
}
