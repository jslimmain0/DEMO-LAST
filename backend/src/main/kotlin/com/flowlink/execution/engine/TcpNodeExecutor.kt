package com.flowlink.execution.engine

import com.flowlink.common.error.NotFoundException
import com.flowlink.common.tcp.TcpBytes
import com.flowlink.core.graph.GraphNode
import com.flowlink.protocol.Direction
import com.flowlink.protocol.Framer
import com.flowlink.protocol.ProtocolCodec
import com.flowlink.protocol.ProtocolDtos
import com.flowlink.protocol.ProtocolService
import com.flowlink.protocol.ProtocolSpec
import com.flowlink.protocol.TcpClient
import org.springframework.stereotype.Component
import java.util.UUID

/**
 * TCP 요청 노드 — "프로토콜에 값을 채운 것". 조립/해석은 ProtocolCodec, 왕복은 TcpClient.
 * 출력 = 응답 헤더 + 본문 필드(정의되지 않은 응답 전문이면 헤더 + `body` raw 텍스트, 노드는 성공).
 */
@Component
class TcpNodeExecutor(private val tokens: TokenResolver, private val protocols: ProtocolService) {

    class Built(val spec: ProtocolSpec, val key: String, val encoded: ProtocolCodec.Encoded, val values: LinkedHashMap<String, String>, val host: String, val port: Int, val timeoutMs: Int, val reqText: String)

    fun build(node: GraphNode, ctx: ExecutionContext): Built {
        val pid = node.protocolId?.trim()?.takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("프로토콜을 선택하세요.")
        val spec = try { protocols.specOf(UUID.fromString(pid)) } catch (e: Exception) {
            if (e is NotFoundException || e is IllegalArgumentException) throw IllegalArgumentException("프로토콜을 찾을 수 없습니다: $pid") else throw e
        }
        val key = node.tcpMessage?.trim()?.takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("전문(거래코드)을 선택하세요.")
        val host = tokens.resolveTokens(node.tcpHost ?: "", ctx).trim()
        val port = node.tcpPort ?: 0
        val values = LinkedHashMap<String, String>()
        for ((k, v) in node.tcpValues ?: emptyMap()) values[k] = if (v.contains("{{")) tokens.stringify(tokens.resolveLiteral(v, ctx)) else v
        val enc = try {
            ProtocolCodec.encode(spec, key, values, Direction.SEND, protocols.plugins())
        } catch (e: ProtocolCodec.ProtocolException) {
            throw IllegalArgumentException(e.message, e)
        } catch (e: RuntimeException) {
            throw IllegalArgumentException("전문 조립 중 오류: ${e.message ?: e}", e)
        }
        val reqText = "TCP $host:$port · $key · ${spec.charset().name()} · ${enc.bytes.size}B\n" + table(enc.fields) + "\n" + TcpBytes.printable(enc.bytes, spec.charset())
        return Built(spec, key, enc, values, host, port, if ((node.tcpTimeoutMs ?: 0) <= 0) 5000 else node.tcpTimeoutMs!!, reqText)
    }

    /** 전송 없이 조립 — 검증/조립 실패는 errors 로(속성 패널이 필드 옆에 표시). */
    fun preview(node: GraphNode, ctx: ExecutionContext): ProtocolDtos.PreviewResult = try {
        val b = build(node, ctx)
        ProtocolDtos.PreviewResult(b.encoded.bytes.size, TcpBytes.hexDump(b.encoded.bytes), TcpBytes.printable(b.encoded.bytes, b.spec.charset()), b.encoded.fields, emptyList(), b.encoded.warnings)
    } catch (e: Exception) {
        val pe = e.cause as? ProtocolCodec.ProtocolException
        ProtocolDtos.PreviewResult(0, "", "", emptyList(), listOf(ProtocolDtos.PreviewError(pe?.field, e.message ?: "조립 실패")))
    }

    fun execute(node: GraphNode, ctx: ExecutionContext): NodeResult {
        val b = try { build(node, ctx) } catch (e: Exception) {
            return NodeResult.fail(0, "TCP ${node.tcpHost ?: ""}:${node.tcpPort ?: 0} · ${node.tcpMessage ?: ""}", "⚠ TCP 전문 조립 실패: " + (e.message ?: e.toString()))
        }
        if (b.host.isBlank()) return NodeResult.fail(0, b.reqText, "⚠ 호스트가 없습니다.")
        return try {
            val x = TcpClient.exchange(b.host, b.port, b.timeoutMs, b.encoded.bytes, b.spec)
            val d = ProtocolCodec.decode(b.spec, x.response.bytes, Direction.RECV, protocols.plugins())
            val out = LinkedHashMap<String, Any?>()
            out.putAll(d.header)
            if (d.body != null) out.putAll(d.body) else out["body"] = TcpBytes.decodeEscaped(d.rawBody, b.spec.charset())
            val sb = StringBuilder("응답 ${x.response.bytes.size}B · ${x.elapsedMs}ms")
            if (d.messageKey == null) sb.append(" · 정의되지 않은 전문 '${d.disc ?: ""}' — 본문 raw(body)")
            if (x.response.chunks.size > 1) sb.append(" · 부분 수신 ${x.response.chunks.joinToString("+")}B")
            for (w in d.warnings) sb.append("\n⚠ ").append(w)
            sb.append('\n').append(table(d.fields)).append('\n').append(TcpBytes.printable(x.response.bytes, b.spec.charset()))
            NodeResult(true, null, b.reqText, sb.toString(), out, out, LinkedHashMap<String, Any?>(b.values), null)
        } catch (e: Framer.FrameException) {
            NodeResult.fail(0, b.reqText, "⚠ 응답 프레이밍 실패: ${e.message}" + (e.raw?.let { "\nHEX " + TcpBytes.hexDump(it) } ?: ""))
        } catch (e: Exception) {
            NodeResult.fail(0, b.reqText, "⚠ TCP 요청 실패: " + (e.message ?: e.toString()))
        }
    }

    private fun table(fields: List<ProtocolCodec.FieldSlice>): String =
        fields.joinToString("\n") { "@${it.offset.toString().padStart(4)} ${it.name} = ${it.value}" + (it.warn?.let { w -> "  $w" } ?: "") }
}
