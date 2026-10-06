package com.flowlink.execution.engine

import com.flowlink.core.graph.GraphNode
import java.net.URI

/** Port references retain the existing integer-port contract. */
object EndpointResolver {
    fun port(node: GraphNode, ctx: ExecutionContext): Int? = node.tcpPortEnvKey?.let { key ->
        val value = (ctx.raw("env") as? Map<*, *>)?.get(key.trim()) as? String
        val port = value?.trim()?.toIntOrNull()
        require(port != null && port in 1..65535) { "목적지 환경의 TCP 포트가 없거나 올바르지 않습니다: $key" }
        port
    }
    fun diagnostics(node: GraphNode, ctx: ExecutionContext, envName: String?, tokens: TokenResolver): Map<String, Any?> {
        tokens.requireResourceReferences(node, ctx)
        val form = node.effectiveType() == com.flowlink.core.graph.NodeType.FORM
        val input = node.effectiveType() == com.flowlink.core.graph.NodeType.INPUT
        val addressFields = if (form) listOf(node.formAction) else if (input) emptyList() else listOf(node.baseUrl, node.path, node.tcpHost)
        val address = if (form) tokens.resolveTokens(node.formAction ?: "", ctx) else if (node.nodeType() == com.flowlink.core.graph.NodeType.HTTP) {
            if (node.baseUrlBound != null) tokens.stringify(tokens.resolveBinding(node.baseUrlBound, ctx)) else tokens.resolveTokens(node.baseUrl ?: "", ctx)
        } else if (node.nodeType() == com.flowlink.core.graph.NodeType.TCP) tokens.resolveTokens(node.tcpHost ?: "", ctx) else null
        val deferred = (!form && !input && node.baseUrlBound?.sourceId?.let { it !in setOf("env", "secret") } == true) ||
            addressFields.filterNotNull().any { text ->
                val m = TokenResolver.tokenPattern().matcher(text)
                var upstream = false
                while (m.find()) if (m.group(3) !in setOf("env", "secret")) upstream = true
                upstream
            }
        val port = if (form || input) null else port(node, ctx) ?: node.tcpPort
        val target = if (address == null || deferred) null else if (form || node.nodeType() == com.flowlink.core.graph.NodeType.HTTP) {
            val uri = runCatching { URI(address + if (form) "" else tokens.resolveTokens(node.path ?: "", ctx)) }.getOrNull()
            require(uri != null && uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank() && uri.port in -1..65535 && uri.port != 0) { "HTTP 주소가 올바르지 않습니다." }
            URI(uri.scheme, null, uri.host, uri.port, uri.path, null, null).toString()
        } else {
            require(!address.isNullOrBlank() && !address.any { it.isWhitespace() || it in "/?#@" } && port != null && port in 1..65535) { "TCP 주소/포트가 올바르지 않습니다." }
            "$address:$port"
        }
        val secrets = (ctx.raw("secret") as? Map<*, *>)?.values?.mapNotNull { it as? String }.orEmpty()
        val safe = target?.let { SecretMasker.mask(it, SecretMasker.variants(secrets)) }
        return mapOf("resolvedTarget" to safe, "source" to if (deferred) "upstream-binding" else if (form || input) "owner-environment" else if (node.baseUrlBound?.sourceId == "env" || listOf(node.baseUrl, node.tcpHost).any { it?.contains("@env") == true } || node.tcpPortEnvKey != null) "destination-environment" else "workflow-address",
            "environment" to envName, "configurationReady" to true, "requester" to if (node.reqMode == "client" || form || input) "browser" else "agent",
            "warnings" to listOf("자원 해석 확인이며 네트워크 접속 가능 여부는 확인하지 않습니다.") + if (deferred) listOf("상류에서 완성한 주소는 데이터로 전달되며 실행 위치에 맞게 자동 치환되지 않습니다.") else if (address != null && node.baseUrlBound == null && listOf(node.baseUrl, node.tcpHost).none { it?.contains("@env") == true }) listOf("고정 주소는 실행 위치에 맞게 자동 치환되지 않습니다.") else emptyList<String>())
    }
}
