package com.flowlink.execution.engine

import com.flowlink.common.error.NotFoundException
import com.flowlink.common.tcp.TcpBytes
import com.flowlink.core.graph.GraphNode
import com.flowlink.protocol.Direction
import com.flowlink.protocol.Framer
import com.flowlink.protocol.ProtocolCodec
import com.flowlink.protocol.ProtocolDtos
import com.flowlink.protocol.ProtocolResources
import com.flowlink.protocol.ProtocolSpec
import com.flowlink.protocol.TcpClient
import com.flowlink.protocol.ProtocolCompiler
import org.springframework.stereotype.Component

/**
 * TCP 요청 노드 — "프로토콜에 값을 채운 것". 조립/해석은 ProtocolCodec, 왕복은 TcpClient.
 * 출력 = 응답 헤더 + 본문 필드(정의되지 않은 응답 전문이면 헤더 + `body` raw 텍스트, 노드는 성공).
 */
@Component
class TcpNodeExecutor(private val tokens: TokenResolver, private val protocols: ProtocolResources) {

    class Built(val spec: ProtocolSpec, val encoded: ProtocolCodec.Encoded, val values: LinkedHashMap<String, String>, val host: String, val port: Int, val timeoutMs: Int, val reqText: String, val plugins: ProtocolCodec.PluginLookup, val fingerprint: String, val sensitive: Boolean = false)

    fun build(node: GraphNode, ctx: ExecutionContext): Built {
        tokens.requireResourceReferences(node, ctx)
        val pid = node.protocolId?.trim()?.takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("프로토콜을 선택하세요.")
        val snapshot = try { protocols.snapshot(pid, ctx.workspaceId, ctx.resourceIdentity) } catch (e: Exception) {
            if (e is NotFoundException || e is IllegalArgumentException) throw IllegalArgumentException("프로토콜을 찾을 수 없습니다: $pid") else throw e
        }
        if (ctx.expectedProtocolFingerprint != null && snapshot.fingerprint != ctx.expectedProtocolFingerprint)
            throw IllegalArgumentException("전문·코덱 버전이 실행 계획과 다릅니다. 다시 실행하세요.")
        val spec = snapshot.spec
        spec.validate().takeIf { it.isNotEmpty() }?.let { throw IllegalArgumentException(it.joinToString(" · ")) }
        val key = node.tcpMessage?.trim()?.takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("전문(거래코드)을 선택하세요.")
        val host = tokens.resolveTokens(node.tcpHost ?: "", ctx).trim()
        val port = EndpointResolver.port(node, ctx) ?: node.tcpPort ?: 0
        val values = LinkedHashMap<String, String>()
        for ((k, v) in node.tcpValues ?: emptyMap()) values[k] = if (v.contains("{{")) tokens.stringify(tokens.resolveLiteral(v, ctx)) else v
        val plugins = snapshot.plugins
        val sensitive = SecretMasker.usesSecrets((ctx.raw("secret") as? Map<*, *>)?.values.orEmpty().map { it.toString() }, spec, node.tcpValues, values)
        val hideCodecErrors = sensitive || ((ctx.raw("secret") as? Map<*, *>)?.isNotEmpty() == true && ProtocolCompiler.pluginRefs(spec).isNotEmpty())
        val enc = try {
            if (spec.schemaVersion == 2) ProtocolCompiler.assemble(spec, key, values, plugins = plugins, resolve = { tokens.resolveTokens(it, ctx) }).let { ProtocolCodec.Encoded(it.bytes, it.fields, it.warnings) }
            else ProtocolCodec.encode(spec, key, values, Direction.SEND, plugins, resolve = { tokens.resolveTokens(it, ctx) })
        } catch (e: ProtocolCodec.ProtocolException) {
            throw IllegalArgumentException(if (hideCodecErrors) SecretMasker.DERIVED_ERROR else e.message, e)
        } catch (e: RuntimeException) {
            throw IllegalArgumentException(if (hideCodecErrors) SecretMasker.DERIVED_ERROR else "전문 조립 중 오류: ${e.message ?: e}", e)
        }
        val reqText = "TCP $host:$port · $key · ${spec.charset().name()} · ${enc.bytes.size}B\n" + if (sensitive) "시크릿 참조가 있어 전문 내용을 숨겼습니다." else table(enc.fields) + "\n" + TcpBytes.printable(enc.bytes, spec.charset())
        return Built(spec, enc, values, host, port, if ((node.tcpTimeoutMs ?: 0) <= 0) 5000 else node.tcpTimeoutMs!!, reqText, plugins, snapshot.fingerprint ?: com.flowlink.protocol.ProtocolFingerprint.of(spec, emptyMap()), sensitive)
    }

    /** 전송 없이 조립 — 검증/조립 실패는 errors 로(속성 패널이 필드 옆에 표시). */
    fun preview(node: GraphNode, ctx: ExecutionContext): ProtocolDtos.PreviewResult = try {
        val b = build(node, ctx)
        val bytes = if (b.sensitive) ByteArray(b.encoded.bytes.size) { '*'.code.toByte() } else b.encoded.bytes
        ProtocolDtos.PreviewResult(bytes.size, TcpBytes.hexDump(bytes), TcpBytes.printable(bytes, b.spec.charset()), if (b.sensitive) b.encoded.fields.map { it.copy(value = "***", warn = null) } else b.encoded.fields, emptyList(), if (b.sensitive) emptyList() else b.encoded.warnings)
    } catch (e: Exception) {
        val pe = e.cause as? ProtocolCodec.ProtocolException
        ProtocolDtos.PreviewResult(0, "", "", emptyList(), listOf(ProtocolDtos.PreviewError(if (e.message == SecretMasker.DERIVED_ERROR) null else pe?.field, e.message ?: "조립 실패")))
    }

    fun execute(node: GraphNode, ctx: ExecutionContext): NodeResult {
        val b = try { build(node, ctx) } catch (e: Exception) {
            return NodeResult.fail(0, "TCP ${node.tcpHost ?: ""}:${node.tcpPort ?: 0} · ${node.tcpMessage ?: ""}", "⚠ TCP 전문 조립 실패: " + (e.message ?: e.toString()))
        }
        if (b.host.isBlank()) return NodeResult.fail(0, b.reqText, "⚠ 호스트가 없습니다.")
        val hideCodecErrors = b.sensitive || ((ctx.raw("secret") as? Map<*, *>)?.isNotEmpty() == true && ProtocolCompiler.pluginRefs(b.spec).isNotEmpty())
        return try {
            if (!ctx.canSendTcp()) throw com.flowlink.protocol.TcpSessionRegistry.NotSentException(com.flowlink.protocol.TcpSessionRegistry.SEND_CANCELLED)
            val retained = b.spec.transport?.connectionOr() == "execution"
            val session = if (retained) ctx.tcpSessions.exchange(ctx.tcpSessionScope, b.host, b.port, b.timeoutMs, b.encoded.bytes, b.spec, b.fingerprint, ctx.canSendTcp, b.plugins) { tokens.resolveTokens(it, ctx) } else null
            val x = session?.exchange ?: TcpClient.exchange(b.host, b.port, b.timeoutMs, b.encoded.bytes, b.spec, ctx.canSendTcp, b.plugins) { tokens.resolveTokens(it, ctx) }
            val effective = x.transactionKey?.let { ProtocolCompiler.compile(b.spec).let { plan -> plan.effectiveSpec(plan.transaction(it)) } } ?: b.spec
            val responseKey = x.transactionKey?.let { ProtocolCompiler.compile(b.spec).transaction(it).responseMessage }
            val d = ProtocolCodec.decode(effective, x.response.bytes, Direction.RECV, b.plugins, resolve = { tokens.resolveTokens(it, ctx) }, messageKey = responseKey)
            val out = LinkedHashMap<String, Any?>()
            out.putAll(d.header)
            if (d.body != null) out.putAll(d.body) else out["body"] = TcpBytes.decodeEscaped(d.rawBody, b.spec.charset())
            val sensitive = b.sensitive || SecretMasker.usesSecrets((ctx.raw("secret") as? Map<*, *>)?.values.orEmpty().map { it.toString() }, out)
            val sb = StringBuilder("응답 ${x.response.bytes.size}B · ${x.elapsedMs}ms")
            if (retained) sb.append(if (session!!.reused) " · 같은 실행의 TCP 연결 재사용" else " · 실행용 TCP 연결 생성")
            x.requestAck?.let { sb.append("\n요청 ACK 수신 HEX ").append(TcpBytes.hexDump(it)) }
            x.responseAck?.let { sb.append("\n응답 ACK 전송 HEX ").append(TcpBytes.hexDump(it)) }
            if (d.messageKey == null) sb.append(" · 정의되지 않은 전문 '${d.disc ?: ""}' — 본문 raw(body)")
            if (x.response.partial) sb.append(" · 부분 수신 ${x.response.chunks.joinToString("+")}B")
            for (w in d.warnings) sb.append("\n⚠ ").append(w)
            sb.append('\n').append(table(d.fields)).append('\n').append(TcpBytes.printable(x.response.bytes, b.spec.charset()))
            if (x.steps.isNotEmpty()) sb.append('\n').append(stepText(x.steps))
            val displayed = if (sensitive) out.mapValues { "***" } else out
            val stored = if (x.steps.isEmpty()) displayed else LinkedHashMap<String, Any?>(displayed).also { it["_tcpTransport"] = mapOf("transactionKey" to x.transactionKey, "transportStatus" to "SUCCEEDED", "steps" to x.steps, "protocolFingerprint" to b.fingerprint) }
            NodeResult(true, null, b.reqText, if (sensitive) "응답 ${x.response.bytes.size}B · 시크릿 참조가 있어 전문 내용을 숨겼습니다.\n${stepText(x.steps)}" else sb.toString(), out, stored, LinkedHashMap<String, Any?>(b.values), null)
        } catch (e: com.flowlink.protocol.TcpSessionRegistry.NotSentException) {
            NodeResult.fail(0, b.reqText, e.message)
        } catch (e: TcpClient.ExchangeException) {
            val preserved = e.response?.let { runCatching { ProtocolCompiler.parse(b.spec, it.bytes, transactionKey = e.steps.firstOrNull()?.transactionKey, phase = "response", plugins = b.plugins, resolve = { value -> tokens.resolveTokens(value, ctx) }).values }.getOrNull() }
            val sensitive = b.sensitive || SecretMasker.usesSecrets((ctx.raw("secret") as? Map<*, *>)?.values.orEmpty().map { it.toString() }, preserved)
            NodeResult.fail(0, b.reqText, "⚠ TCP 전송 미완료: ${if (hideCodecErrors) SecretMasker.DERIVED_ERROR else e.message}\n" + stepText(e.steps)).copy(uncertain = true,
                storedValue = mapOf("responseFields" to if (sensitive) preserved?.mapValues { "***" } else preserved, "_tcpTransport" to mapOf("transportStatus" to "FAILED", "steps" to e.steps, "protocolFingerprint" to b.fingerprint)), reqValues = b.values)
        } catch (e: Framer.FrameException) {
            NodeResult.fail(0, b.reqText, if (hideCodecErrors) SecretMasker.DERIVED_ERROR else "⚠ 응답 프레이밍 실패: ${e.message}" + (e.raw?.let { "\nHEX " + TcpBytes.hexDump(it) } ?: "")).copy(uncertain = true)
        } catch (e: Exception) {
            NodeResult.fail(0, b.reqText, if (hideCodecErrors) SecretMasker.DERIVED_ERROR else "⚠ TCP 요청 실패: " + (e.message ?: e.toString())).copy(uncertain = true)
        }
    }

    private fun table(fields: List<ProtocolCodec.FieldSlice>): String =
        fields.joinToString("\n") { "@${it.offset.toString().padStart(4)} ${it.name} = ${it.value}" + (it.warn?.let { w -> "  $w" } ?: "") }
    private fun stepText(steps: List<TcpClient.Step>): String = steps.joinToString("\n") { "${it.phase} ${it.status} ${it.actualBytes}/${it.expectedBytes ?: "?"}B ${it.errorCode.orEmpty()}" }
}
