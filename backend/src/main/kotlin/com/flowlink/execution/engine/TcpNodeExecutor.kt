package com.flowlink.execution.engine

import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import com.flowlink.core.graph.TcpField
import org.springframework.stereotype.Component
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import java.util.Arrays

/**
 * 고정길이 금융 전문 TCP 노드 실행기.
 * 요청 필드를 바이트 단위 고정길이로 조립해 길이-프리픽스 전문으로 전송하고,
 * 응답 전문을 응답 필드 길이대로 잘라 출력으로 만든다. (인코딩 노드/필드별 선택)
 */
@Component
class TcpNodeExecutor(
    private val tokens: TokenResolver,
    private val ssrfGuard: SsrfGuard,
    private val json: JsonService
) {

    /**
     * 조립된 요청 전문 + 필드별 분해 정보(미리보기/전송 공용).
     * [slices] 는 프리픽스 이후 본문 기준 오프셋(프리픽스는 [prefixLen] 바이트로 앞에 붙음).
     */
    data class FieldSlice(
        val name: String?,
        val offset: Int,        // 본문 내 시작 오프셋(프리픽스 제외)
        val declaredLen: Int,   // 선언 길이
        val actualBytes: Int,   // 값의 원시 바이트 수(패딩/절단 전)
        val truncated: Boolean, // actualBytes > declaredLen (초과 절단)
        val padded: Boolean,    // actualBytes < declaredLen (패딩 채움)
        val pad: String,        // left|right
        val text: String,       // 해석된 값(표시용)
        val encoding: String,
    )

    class Built(
        val message: ByteArray,
        val bodySize: Int,
        val prefixLen: Int,
        val declaredPrefix: Int?, // 프리픽스에 쓴 숫자(없으면 null)
        val slices: List<FieldSlice>,
        val reqValues: LinkedHashMap<String, Any?>,
        val host: String,
        val port: Int,
        val encoding: Charset,
        val reqText: String,
    )

    /** 요청 전문 조립(전송 없음) — execute/preview 공용. */
    fun build(node: GraphNode, ctx: ExecutionContext): Built {
        val host = tokens.resolveTokens(node.tcpHost ?: "", ctx)
        val port = node.tcpPort ?: 0
        val nodeCs = charset(node.tcpEncoding, Charset.forName("EUC-KR"))
        val prefixLen = node.tcpPrefixLength ?: 0
        val includesSelf = node.tcpPrefixIncludesSelf == true

        val reqValues = LinkedHashMap<String, Any?>()
        val bodyBuf = ByteArrayOutputStream()
        val slices = ArrayList<FieldSlice>()
        var offset = 0
        for (f in node.tcpRequest ?: emptyList()) {
            val v = resolveField(f, ctx)
            if (f.name != null && !f.name.isBlank()) reqValues[f.name] = v
            val cs = charset(f.encoding, nodeCs)
            val declared = f.lengthOrZero()
            val actual = (v ?: "").toByteArray(cs).size
            val field = fixedField(v, declared, f.pad, f.padChar, cs)
            bodyBuf.writeBytes(field)
            slices.add(FieldSlice(
                name = f.name, offset = offset, declaredLen = declared, actualBytes = actual,
                truncated = actual > declared, padded = actual < declared,
                pad = if ("left".equals(f.pad, ignoreCase = true)) "left" else "right",
                text = v ?: "", encoding = cs.name(),
            ))
            offset += declared
        }
        val body = bodyBuf.toByteArray()

        val message: ByteArray
        var declaredPrefix: Int? = null
        if (prefixLen > 0) {
            val declared = if (includesSelf) body.size + prefixLen else body.size
            declaredPrefix = declared
            val prefix = prefix(declared, prefixLen)
            val m = ByteArray(prefix.size + body.size)
            System.arraycopy(prefix, 0, m, 0, prefix.size)
            System.arraycopy(body, 0, m, prefix.size, body.size)
            message = m
        } else {
            message = body
        }
        val reqText = "TCP " + host + ":" + port + " (" + nodeCs.name() + ", " + message.size + "B)\n" + printable(message, nodeCs)
        return Built(message, body.size, prefixLen, declaredPrefix, slices, reqValues, host, port, nodeCs, reqText)
    }

    /** 미리보기 — 전송 없이 조립 결과(hex/printable/필드 오프셋/오버플로)를 돌려준다. */
    fun preview(node: GraphNode, ctx: ExecutionContext): TcpPreview {
        val b = build(node, ctx)
        return TcpPreview(
            host = b.host, port = b.port, encoding = b.encoding.name(),
            totalBytes = b.message.size, prefixLen = b.prefixLen, declaredPrefix = b.declaredPrefix,
            bodyBytes = b.bodySize, hex = hexDump(b.message), printable = printable(b.message, b.encoding),
            fields = b.slices.map {
                TcpPreview.Field(it.name, it.offset + b.prefixLen, it.declaredLen, it.actualBytes, it.truncated, it.padded, it.pad, it.text, it.encoding)
            },
        )
    }

    fun execute(node: GraphNode, ctx: ExecutionContext): NodeResult {
        val built = build(node, ctx)
        val host = built.host
        val port = built.port
        val nodeCs = built.encoding
        val timeout = if (node.tcpTimeoutMs == null || node.tcpTimeoutMs <= 0) 5000 else node.tcpTimeoutMs
        val prefixLen = built.prefixLen
        val includesSelf = node.tcpPrefixIncludesSelf == true
        val reqValues = built.reqValues
        val message = built.message
        val reqText = built.reqText

        // 3) SSRF
        try {
            ssrfGuard.checkHostPort(host, port)
        } catch (e: SsrfBlockedException) {
            return NodeResult.fail(0, reqText, "⚠ 차단됨(SSRF 가드): " + e.message)
        }

        // 4) 송수신
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), timeout)
                socket.soTimeout = timeout
                val out: OutputStream = socket.getOutputStream()
                out.write(message)
                out.flush()

                val input: InputStream = socket.getInputStream()
                val respBody: ByteArray
                if (prefixLen > 0) {
                    val pre = readN(input, prefixLen)
                    val declared: Int = try {
                        String(pre, StandardCharsets.US_ASCII).trim().toInt()
                    } catch (e: NumberFormatException) {
                        return NodeResult.fail(0, reqText, "⚠ 응답 길이 프리픽스 파싱 실패: '" + String(pre, StandardCharsets.US_ASCII) + "'")
                    }
                    val bodyLen = if (includesSelf) declared - prefixLen else declared
                    if (bodyLen < 0) {
                        return NodeResult.fail(0, reqText, "⚠ 잘못된 응답 길이: $declared")
                    }
                    respBody = readN(input, bodyLen)
                } else {
                    respBody = input.readAllBytes()
                }

                // 5) 응답 슬라이싱 → 출력
                val value = LinkedHashMap<String, Any?>()
                var offset = 0
                for (rf in node.tcpResponse ?: emptyList()) {
                    val len = rf.lengthOrZero()
                    val end = Math.min(offset + len, respBody.size)
                    val slice = Arrays.copyOfRange(respBody, Math.min(offset, respBody.size), end)
                    val decoded = String(slice, charset(rf.encoding, nodeCs))
                    if (rf.name != null && !rf.name.isBlank()) {
                        value[rf.name] = decoded
                    }
                    offset += len
                }
                val resText = "응답 " + respBody.size + "B\n" + printable(respBody, nodeCs)
                NodeResult(true, null, reqText, resText, value, value, reqValues, null)
            }
        } catch (e: Exception) {
            NodeResult.fail(0, reqText, "⚠ TCP 요청 실패: " + (e.message ?: e.toString()))
        }
    }

    private fun resolveField(f: TcpField, ctx: ExecutionContext): String {
        if (f.bound != null) {
            return tokens.stringify(tokens.resolveBinding(f.bound, ctx))
        }
        val v = f.value
        // 인라인 토큰 규칙 공용(resolveLiteral) — 어차피 고정길이 문자열로 직렬화되므로 stringify
        return if (v != null && v.contains("{{")) tokens.stringify(tokens.resolveLiteral(v, ctx)) else (v ?: "")
    }

    companion object {
        private fun readN(input: InputStream, n: Int): ByteArray {
            val buf = input.readNBytes(n)
            if (buf.size < n) {
                throw IOException("응답이 조기 종료됨 (" + buf.size + "/" + n + " 바이트)")
            }
            return buf
        }

        private fun prefix(declared: Int, width: Int): ByteArray {
            val s = String.format("%0" + width + "d", declared)
            val b = s.toByteArray(StandardCharsets.US_ASCII)
            if (b.size > width) {
                // 길이 오버플로 — 하위 width 자리만(방어적)
                return Arrays.copyOfRange(b, b.size - width, b.size)
            }
            return b
        }

        private fun fixedField(value: String?, length: Int, pad: String?, padChar: String?, cs: Charset): ByteArray {
            val raw = (value ?: "").toByteArray(cs)
            if (length <= 0) {
                return ByteArray(0)
            }
            if (raw.size == length) {
                return raw
            }
            if (raw.size > length) {
                return Arrays.copyOf(raw, length) // 초과 시 절단
            }
            val out = ByteArray(length)
            val pb = padByte(padChar, cs)
            if ("left".equals(pad, ignoreCase = true)) {
                val padCount = length - raw.size
                Arrays.fill(out, 0, padCount, pb)
                System.arraycopy(raw, 0, out, padCount, raw.size)
            } else { // 기본 right
                System.arraycopy(raw, 0, out, 0, raw.size)
                Arrays.fill(out, raw.size, length, pb)
            }
            return out
        }

        private fun padByte(padChar: String?, cs: Charset): Byte {
            val p = if (padChar == null || padChar.isEmpty()) " " else padChar
            val b = p.toByteArray(cs)
            return if (b.isNotEmpty()) b[0] else ' '.code.toByte()
        }

        private fun charset(name: String?, def: Charset): Charset {
            if (name == null || name.isBlank()) {
                return def
            }
            return try {
                Charset.forName(name)
            } catch (e: Exception) {
                def
            }
        }

        private fun printable(bytes: ByteArray, cs: Charset): String {
            val s = String(bytes, cs)
            val sb = StringBuilder(s.length)
            for (i in 0 until s.length) {
                val c = s[i]
                sb.append(if (c.code < 0x20) '.' else c)
            }
            return sb.toString()
        }

        /** 공백 구분 2자리 대문자 hex(바이트별). 미리보기용. */
        private fun hexDump(bytes: ByteArray): String {
            val sb = StringBuilder(bytes.size * 3)
            for (i in bytes.indices) {
                if (i > 0) sb.append(' ')
                sb.append(String.format("%02X", bytes[i].toInt() and 0xFF))
            }
            return sb.toString()
        }
    }
}

/** TCP 요청 전문 미리보기 결과(전송 없음) — 프론트가 조립 바이트/필드 오프셋/오버플로를 표시. */
data class TcpPreview(
    val host: String,
    val port: Int,
    val encoding: String,
    val totalBytes: Int,
    val prefixLen: Int,
    val declaredPrefix: Int?,
    val bodyBytes: Int,
    val hex: String,
    val printable: String,
    val fields: List<Field>,
) {
    data class Field(
        val name: String?,
        val offset: Int,       // 전문 시작 기준 절대 오프셋(프리픽스 포함)
        val declaredLen: Int,
        val actualBytes: Int,
        val truncated: Boolean,
        val padded: Boolean,
        val pad: String,
        val text: String,
        val encoding: String,
    )
}
