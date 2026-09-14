package com.flowlink.execution.engine

import com.flowlink.common.json.JsonService
import com.flowlink.common.tcp.TcpBytes
import com.flowlink.common.tcp.TcpLen
import com.flowlink.core.graph.GraphNode
import com.flowlink.core.graph.TcpField
import com.flowlink.core.graph.TcpRespField
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
 * 요청 필드 값에는 전문 길이 토큰([TcpLen]: `{{len}}`·`{{len:4}}`·`{{len:frame}}`·`{{len:frame:4}}`)을 쓸 수 있다 —
 * 본문 길이 = 요청 필드 **선언 길이의 합**, frame = 그 값 + 길이 프리픽스 폭.
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

        // 고정길이 필드가 ByteArray(length) 를 직접 할당하므로, 과대 길이(오타/악의)로 OOM 되지 않게 상한.
        // (금융 전문은 KB 단위 — preview 엔드포인트가 임의 노드를 받으니 반드시 가드) 프리픽스 폭도 상한.
        if (prefixLen < 0 || prefixLen > MAX_PREFIX_WIDTH) throw IllegalArgumentException("길이 프리픽스 폭이 범위를 벗어났습니다: $prefixLen")
        var declaredTotal = 0L
        for (f in node.tcpRequest ?: emptyList()) {
            val len = f.lengthOrZero()
            if (len < 0) throw IllegalArgumentException("필드 길이는 음수일 수 없습니다: ${f.name}=$len")
            declaredTotal += len
            if (declaredTotal > MAX_TCP_MESSAGE) throw IllegalArgumentException("요청 전문 총 길이가 상한(${MAX_TCP_MESSAGE}B)을 초과했습니다.")
        }

        // 전문 길이 토큰({{len}}·{{len:4}}·{{len:frame}}) — 모든 필드가 고정길이라 본문 길이 = **선언 길이의 합**(순환 없음).
        // 프레임은 프리픽스 바이트가 실제로 앞에 붙으므로 본문 + 프리픽스 폭(프리픽스 없으면 본문 길이 그대로).
        val lenBody = declaredTotal.toInt()
        val lenFrame = lenBody + (if (prefixLen > 0) prefixLen else 0)

        val reqValues = LinkedHashMap<String, Any?>()
        val bodyBuf = ByteArrayOutputStream()
        val slices = ArrayList<FieldSlice>()
        var offset = 0
        for (f in node.tcpRequest ?: emptyList()) {
            val v = resolveField(f, ctx, lenBody, lenFrame)
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
        val built = try {
            build(node, ctx)
        } catch (e: IllegalArgumentException) {
            return NodeResult.fail(0, "", "⚠ TCP 전문 조립 실패: " + (e.message ?: e.toString()))
        }
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
                        value[rf.name] = postProcess(decoded, rf)
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

    /**
     * 필드 값 — 바인딩이면 그 값, 아니면 리터럴 토큰 치환.
     * **길이 토큰([TcpLen])을 먼저** 치환한다(상위 노드 바인딩이 아니라 전문 자체의 길이라 TokenResolver 가 알 수 없다 —
     * bare `{{len}}` 이 미해석 바인딩으로 빈 값이 되지 않게). 치환 후 남은 토큰만 기존 해석기로.
     */
    private fun resolveField(f: TcpField, ctx: ExecutionContext, lenBody: Int, lenFrame: Int): String {
        if (f.bound != null) {
            return tokens.stringify(tokens.resolveBinding(f.bound, ctx))
        }
        val v = if (TcpLen.hasToken(f.value)) TcpLen.resolve(f.value, lenBody, lenFrame) else f.value
        // 인라인 토큰 규칙 공용(resolveLiteral) — 어차피 고정길이 문자열로 직렬화되므로 stringify
        return if (v != null && v.contains("{{")) tokens.stringify(tokens.resolveLiteral(v, ctx)) else (v ?: "")
    }

    companion object {
        /** 요청 전문 총 길이 상한(선언 길이 합) — OOM 방지. 금융 전문은 KB 단위라 1MB 로도 넉넉. */
        const val MAX_TCP_MESSAGE = 1 shl 20 // 1MB
        /** 길이 프리픽스 폭 상한(자리수) — `%0Nd` 포맷·ByteArray(N) 방어. */
        const val MAX_PREFIX_WIDTH = 20

        private fun readN(input: InputStream, n: Int): ByteArray {
            val buf = input.readNBytes(n)
            if (buf.size < n) {
                throw IOException("응답이 조기 종료됨 (" + buf.size + "/" + n + " 바이트)")
            }
            return buf
        }

        private fun prefix(declared: Int, width: Int): ByteArray = TcpBytes.prefix(declared, width)

        private fun fixedField(value: String?, length: Int, pad: String?, padChar: String?, cs: Charset): ByteArray =
            TcpBytes.fixedField(value, length, pad, padChar, cs)

        private fun charset(name: String?, def: Charset): Charset = TcpBytes.charset(name, def)

        private fun printable(bytes: ByteArray, cs: Charset): String = TcpBytes.printable(bytes, cs)

        private fun hexDump(bytes: ByteArray): String = TcpBytes.hexDump(bytes)

        /** 응답 필드 후처리(순수) — trim/type 규칙. 레거시(둘 다 null)는 원문 그대로(무회귀). */
        @JvmStatic
        fun postProcess(decoded: String, rf: TcpRespField): Any? {
            val number = rf.type == "number"
            val trimmed = when {
                rf.trim == true && number -> decoded.trim().trimStart('0').ifEmpty { "0" }
                rf.trim == true -> decoded.trimEnd()
                else -> decoded
            }
            if (!number) return trimmed
            val t = trimmed.trim().trimStart('0').ifEmpty { "0" }
            return t.toLongOrNull() ?: t.toDoubleOrNull() ?: trimmed
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
