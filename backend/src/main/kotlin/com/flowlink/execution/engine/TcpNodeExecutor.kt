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

    fun execute(node: GraphNode, ctx: ExecutionContext): NodeResult {
        val host = tokens.resolveTokens(node.tcpHost ?: "", ctx)
        val port = node.tcpPort ?: 0
        val nodeCs = charset(node.tcpEncoding, Charset.forName("EUC-KR"))
        val timeout = if (node.tcpTimeoutMs == null || node.tcpTimeoutMs <= 0) 5000 else node.tcpTimeoutMs
        val prefixLen = node.tcpPrefixLength ?: 0
        val includesSelf = node.tcpPrefixIncludesSelf == true

        // 1) 요청 전문 본문 조립(바이트 고정길이)
        val reqValues = LinkedHashMap<String, Any?>()
        val bodyBuf = ByteArrayOutputStream()
        for (f in node.tcpRequest ?: emptyList()) {
            val v = resolveField(f, ctx)
            if (f.name != null && !f.name.isBlank()) {
                reqValues[f.name] = v
            }
            val cs = charset(f.encoding, nodeCs)
            val field = fixedField(v, f.lengthOrZero(), f.pad, f.padChar, cs)
            bodyBuf.writeBytes(field)
        }
        val body = bodyBuf.toByteArray()

        // 2) 길이 프리픽스
        val message: ByteArray
        if (prefixLen > 0) {
            val declared = if (includesSelf) body.size + prefixLen else body.size
            val prefix = prefix(declared, prefixLen)
            val m = ByteArray(prefix.size + body.size)
            System.arraycopy(prefix, 0, m, 0, prefix.size)
            System.arraycopy(body, 0, m, prefix.size, body.size)
            message = m
        } else {
            message = body
        }

        val reqText = "TCP " + host + ":" + port + " (" + nodeCs.name() + ", " + message.size + "B)\n" + printable(message, nodeCs)

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
    }
}
