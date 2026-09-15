package com.flowlink.protocol

import com.flowlink.codec.CodecCtx
import com.flowlink.codec.CodecPlugin
import com.flowlink.codec.FieldCodec
import com.flowlink.codec.FieldInfo
import com.flowlink.codec.MessageCodec
import com.flowlink.common.tcp.TcpBytes
import com.flowlink.protocol.ProtocolSpec.Field
import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import java.util.LinkedHashMap

/**
 * 전문 조립/해석 엔진(순수). 송신: 값 → FieldCodec.encode → 문자셋 → 패딩 → 본문 결합 → MessageCodec.encode → 길이 계산 + 헤더.
 * 수신: 정확히 역순. 헤더는 항상 평문(길이·거래코드로 프레이밍/라우팅).
 */
object ProtocolCodec {

    class ProtocolException(val field: String?, message: String) : RuntimeException(message)

    data class FieldSlice(val name: String, val offset: Int, val len: Int, val actualBytes: Int, val value: String, val warn: String? = null)
    class Encoded(val bytes: ByteArray, val fields: List<FieldSlice>, val warnings: List<String>)
    class Decoded(
        val header: LinkedHashMap<String, String>,
        val disc: String?,
        val messageKey: String?,
        val body: LinkedHashMap<String, String>?,
        val rawBody: ByteArray,
        val fields: List<FieldSlice>,
        val warnings: List<String>,
    ) {
        /** 헤더+본문 값(템플릿·조건·출력용). */
        fun values(): LinkedHashMap<String, String> = LinkedHashMap<String, String>().also { it.putAll(header); body?.let { b -> it.putAll(b) } }
    }

    fun interface PluginLookup { fun find(id: String): CodecPlugin? }
    val NO_PLUGINS = PluginLookup { null }

    // ---------- 길이 ----------

    fun declaredLength(spec: ProtocolSpec, total: Int): Int =
        if (spec.includesSelf == true) total else total - (spec.lengthFieldDef()?.lenOrZero() ?: 0)

    fun totalFromDeclared(spec: ProtocolSpec, declared: Int): Int =
        if (spec.includesSelf == true) declared else declared + (spec.lengthFieldDef()?.lenOrZero() ?: 0)

    /** 헤더 바이트에서 길이값. ascii 는 패딩 제거 후 정수, binary 는 endian. 실패 시 원본 바이트를 담은 예외. */
    fun parseLength(spec: ProtocolSpec, headerBytes: ByteArray): Int {
        val lf = spec.lengthFieldDef() ?: throw ProtocolException(null, "길이 필드 정의가 없습니다.")
        val off = spec.lengthFieldOffset()
        if (headerBytes.size < off + lf.lenOrZero()) throw ProtocolException(lf.nameOrEmpty(), "헤더가 길이 필드까지 오지 않았습니다(${headerBytes.size}B).")
        val slice = headerBytes.copyOfRange(off, off + lf.lenOrZero())
        val n = if (spec.isBinaryLength()) binaryToInt(slice, spec.isLittleEndian())
        else trimPad(String(slice, StandardCharsets.US_ASCII), lf.padOr()).trim().toIntOrNull()
            ?: throw ProtocolException(lf.nameOrEmpty(), "길이 필드에 '${TcpBytes.printable(slice, StandardCharsets.US_ASCII)}' 가 왔다 (hex ${TcpBytes.hexDump(slice)})")
        if (n < 0) throw ProtocolException(lf.nameOrEmpty(), "길이값이 음수입니다: $n")
        return n
    }

    /** 이미 조립된 전문의 길이 필드만 다른 값으로 바꿔 쓴다(장애 주입 corrupt-length). */
    fun withLength(spec: ProtocolSpec, frame: ByteArray, declared: Int): ByteArray {
        val lf = spec.lengthFieldDef() ?: return frame
        val off = spec.lengthFieldOffset()
        val out = frame.copyOf()
        val bytes = lengthBytes(spec, lf, declared)
        System.arraycopy(bytes, 0, out, off, minOf(bytes.size, out.size - off))
        return out
    }

    private fun lengthBytes(spec: ProtocolSpec, lf: Field, declared: Int): ByteArray {
        if (spec.isBinaryLength()) return intToBinary(declared, lf.lenOrZero(), spec.isLittleEndian())
        val s = declared.toString()
        if (s.length > lf.lenOrZero()) throw ProtocolException(lf.nameOrEmpty(), "전문 길이 $declared 가 길이 필드 ${lf.lenOrZero()}자리를 넘습니다.")
        return pad(s.toByteArray(StandardCharsets.US_ASCII), lf.lenOrZero(), lf.padOr(), false)
    }

    private fun binaryToInt(b: ByteArray, little: Boolean): Int {
        var v = 0L
        val idx = if (little) b.indices.reversed() else b.indices
        for (i in idx) v = (v shl 8) or (b[i].toLong() and 0xFF)
        if (v > Int.MAX_VALUE) throw ProtocolException(null, "길이값이 너무 큽니다: $v")
        return v.toInt()
    }

    private fun intToBinary(v: Int, len: Int, little: Boolean): ByteArray {
        val out = ByteArray(len)
        for (i in 0 until len) {
            val shift = 8 * (if (little) i else len - 1 - i)
            out[i] = ((v.toLong() ushr shift) and 0xFF).toByte()
        }
        return out
    }

    // ---------- 패딩 ----------

    /** 패딩 채움. binary 는 0x00, 그 외 pad 규칙(공백/0). raw 가 len 보다 길면 그대로(호출자가 먼저 절단/검증). */
    private fun pad(raw: ByteArray, len: Int, pad: String, binary: Boolean): ByteArray {
        if (raw.size >= len) return raw
        val out = ByteArray(len)
        val fill: Byte = if (binary) 0 else if (pad == "left/zero") '0'.code.toByte() else ' '.code.toByte()
        val left = pad.startsWith("left")
        java.util.Arrays.fill(out, fill)
        System.arraycopy(raw, 0, out, if (left) len - raw.size else 0, raw.size)
        return out
    }

    fun trimPad(s: String, pad: String): String = when (pad) {
        "right/space" -> s.trimEnd(' ')
        "left/space" -> s.trimStart(' ')
        "left/zero" -> s.trimStart('0').ifEmpty { if (s.isEmpty()) "" else "0" }
        else -> s
    }

    // ---------- encode ----------

    fun encode(
        spec: ProtocolSpec, key: String, values: Map<String, String>, dir: Direction = Direction.SEND,
        plugins: PluginLookup = NO_PLUGINS, lenient: Boolean = false,
    ): Encoded {
        val msg = spec.message(key) ?: throw ProtocolException(null, "정의되지 않은 전문: $key")
        val cs = spec.charset()
        val all = LinkedHashMap<String, String>(values)
        if (spec.hasDiscriminator()) {
            val d = spec.discriminator!!.trim()
            if (all[d].isNullOrBlank()) all[d] = spec.discValueOf(key)
        }
        val warnings = ArrayList<String>()
        val slices = ArrayList<FieldSlice>()
        val body = ByteArrayOutputStream()
        var offset = spec.headerLen()
        for (f in msg.fieldsOrEmpty()) {
            val r = encodeField(f, all[f.nameOrEmpty()] ?: "", offset, cs, all, plugins, lenient, dir)
            body.write(r.first); slices.add(r.second); r.second.warn?.let { warnings += it }
            offset += f.lenOrZero()
        }
        var bodyBytes = body.toByteArray()
        for (p in spec.messagePlugins ?: emptyList()) {
            val id = p.id?.trim().orEmpty(); if (id.isEmpty()) continue
            val mc = plugins.find(id) as? MessageCodec ?: throw ProtocolException(null, "메시지 플러그인 '$id' 을 찾을 수 없습니다(MessageCodec).")
            bodyBytes = mc.encode(bodyBytes, CodecCtx(null, all, p.configOrEmpty(), dir.name.lowercase()))
        }
        val total = spec.headerLen() + bodyBytes.size
        val head = ByteArrayOutputStream()
        val headSlices = ArrayList<FieldSlice>()
        offset = 0
        for (f in spec.headerOrEmpty()) {
            val n = f.nameOrEmpty()
            if (f.typeOr() == "length") {
                val declared = declaredLength(spec, total)
                val b = lengthBytes(spec, f, declared)
                head.write(b); headSlices.add(FieldSlice(n, offset, f.lenOrZero(), b.size, declared.toString()))
            } else {
                val r = encodeField(f, all[n] ?: "", offset, cs, all, plugins, lenient, dir)
                head.write(r.first); headSlices.add(r.second); r.second.warn?.let { warnings += it }
            }
            offset += f.lenOrZero()
        }
        val out = ByteArray(total)
        System.arraycopy(head.toByteArray(), 0, out, 0, spec.headerLen())
        System.arraycopy(bodyBytes, 0, out, spec.headerLen(), bodyBytes.size)
        return Encoded(out, headSlices + slices, warnings)
    }

    private fun encodeField(
        f: Field, value: String, offset: Int, cs: Charset, message: Map<String, String>,
        plugins: PluginLookup, lenient: Boolean, dir: Direction,
    ): Pair<ByteArray, FieldSlice> {
        val name = f.nameOrEmpty()
        val type = f.typeOr()
        val len = f.lenOrZero()
        var v = value
        f.plugin?.id?.trim()?.takeIf { it.isNotEmpty() }?.let { id ->
            val fc = plugins.find(id) as? FieldCodec ?: throw ProtocolException(name, "필드 플러그인 '$id' 을 찾을 수 없습니다(FieldCodec).")
            v = fc.encode(v, CodecCtx(FieldInfo(name, len, type, f.padOr()), message, f.plugin.configOrEmpty(), dir.name.lowercase()))
        }
        val binary = type == "binary"
        var raw: ByteArray = when (type) {
            "binary" -> TcpBytes.hexToBytes(v) ?: throw ProtocolException(name, "'$name' 값이 hex 형식이 아닙니다: '$v'")
            "ascii", "length" -> { v.firstOrNull { it.code > 0x7F }?.let { throw ProtocolException(name, "ascii 필드 '$name' 에 비ASCII 문자('$it')가 있습니다.") }; v.toByteArray(StandardCharsets.US_ASCII) }
            "numeric" -> { if (v.any { !it.isDigit() }) throw ProtocolException(name, "numeric 필드 '$name' 에 숫자가 아닌 문자가 있습니다: '$v'"); v.toByteArray(StandardCharsets.US_ASCII) }
            else -> v.toByteArray(cs)
        }
        val actual = raw.size
        var warn: String? = null
        if (raw.size > len) {
            if (!lenient) throw ProtocolException(name, "'$name' 값이 ${len}바이트를 초과합니다(${raw.size}바이트).")
            // ponytail: 문자 하나씩 떼며 재인코딩 — 필드는 수십 바이트라 O(n²) 무시
            var cut = v
            if (binary) raw = raw.copyOf(len) else { while (cut.toByteArray(cs).size > len) cut = cut.dropLast(1); raw = cut.toByteArray(cs) }
            warn = "⚠ '$name' (${actual}B) → ${len}B — 초과분 잘림"
        }
        return pad(raw, len, f.padOr(), binary) to FieldSlice(name, offset, len, actual, v, warn)
    }

    // ---------- decode ----------

    fun decode(spec: ProtocolSpec, frame: ByteArray, dir: Direction = Direction.RECV, plugins: PluginLookup = NO_PLUGINS): Decoded {
        val cs = spec.charset()
        val hl = spec.headerLen()
        if (frame.size < hl) throw ProtocolException(null, "전문(${frame.size}B)이 헤더 길이(${hl}B)보다 짧습니다.")
        val warnings = ArrayList<String>()
        val header = LinkedHashMap<String, String>()
        val slices = ArrayList<FieldSlice>()
        var offset = 0
        for (f in spec.headerOrEmpty()) {
            val slice = frame.copyOfRange(offset, offset + f.lenOrZero())
            val v = if (f.typeOr() == "length") parseLength(spec, frame).toString() else decodeField(f, slice, cs, header, plugins, dir)
            header[f.nameOrEmpty()] = v
            slices.add(FieldSlice(f.nameOrEmpty(), offset, f.lenOrZero(), slice.size, v))
            offset += f.lenOrZero()
        }
        val declared = parseLength(spec, frame)
        val expectTotal = totalFromDeclared(spec, declared)
        if (expectTotal != frame.size) warnings += "길이 필드 불일치 — 선언 $declared(전체 ${expectTotal}B), 실제 ${frame.size}B"
        var body = frame.copyOfRange(hl, frame.size)
        for (p in (spec.messagePlugins ?: emptyList()).asReversed()) {
            val id = p.id?.trim().orEmpty(); if (id.isEmpty()) continue
            val mc = plugins.find(id) as? MessageCodec ?: throw ProtocolException(null, "메시지 플러그인 '$id' 을 찾을 수 없습니다(MessageCodec).")
            body = mc.decode(body, CodecCtx(null, header, p.configOrEmpty(), dir.name.lowercase()))
        }
        val disc = if (spec.hasDiscriminator()) header[spec.discriminator!!.trim()] else null
        val msg = spec.lookup(disc, dir) ?: return Decoded(header, disc, null, null, body, slices, warnings)
        val map = LinkedHashMap<String, String>()
        val all = LinkedHashMap<String, String>(header)
        offset = 0
        for (f in msg.fieldsOrEmpty()) {
            val end = minOf(offset + f.lenOrZero(), body.size)
            val slice = if (offset >= body.size) ByteArray(0) else body.copyOfRange(offset, end)
            if (slice.size < f.lenOrZero()) warnings += "본문이 짧아 '${f.nameOrEmpty()}' 가 ${slice.size}/${f.lenOrZero()}B 만 왔습니다."
            val v = decodeField(f, slice, cs, all, plugins, dir)
            map[f.nameOrEmpty()] = v; all[f.nameOrEmpty()] = v
            slices.add(FieldSlice(f.nameOrEmpty(), hl + offset, f.lenOrZero(), slice.size, v))
            offset += f.lenOrZero()
        }
        if (body.size > offset) warnings += "본문에 정의보다 ${body.size - offset}B 가 더 있습니다."
        return Decoded(header, disc, msg.keyOrEmpty(), map, body, slices, warnings)
    }

    private fun decodeField(f: Field, slice: ByteArray, cs: Charset, message: Map<String, String>, plugins: PluginLookup, dir: Direction): String {
        val type = f.typeOr()
        var v = when (type) {
            "binary" -> TcpBytes.hexDump(slice)
            "ascii", "numeric" -> trimPad(TcpBytes.decodeEscaped(slice, StandardCharsets.US_ASCII), f.padOr())
            else -> trimPad(TcpBytes.decodeEscaped(slice, cs), f.padOr())
        }
        f.plugin?.id?.trim()?.takeIf { it.isNotEmpty() }?.let { id ->
            val fc = plugins.find(id) as? FieldCodec ?: throw ProtocolException(f.nameOrEmpty(), "필드 플러그인 '$id' 을 찾을 수 없습니다(FieldCodec).")
            v = fc.decode(v, CodecCtx(FieldInfo(f.nameOrEmpty(), f.lenOrZero(), type, f.padOr()), message, f.plugin.configOrEmpty(), dir.name.lowercase()))
        }
        return v
    }
}
