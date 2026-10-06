package com.flowlink.execution

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.engine.HttpNodeExecutor
import com.flowlink.workspace.WorkspaceService
import com.flowlink.common.lifecycle.RuntimeUpdateGate
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/v1/agent")
class AgentHttpController(private val executor: HttpNodeExecutor, private val mapper: ObjectMapper, private val workspaces: WorkspaceService, private val gate: RuntimeUpdateGate) {
    data class Request(val executionAgent: String, val method: String = "GET", val url: String, val headers: Map<String, String> = emptyMap(), val body: String? = null, val timeoutSec: Int = 30)
    @PostMapping("/http-request")
    fun execute(@RequestBody request: Request, servlet: jakarta.servlet.http.HttpServletRequest): HttpNodeExecutor.OneoffResponse = gate.work {
        require(request.executionAgent == if (workspaces.localRuntime) "local" else "server") { "요청한 실행 위치와 현재 에이전트가 다릅니다." }
        require(request.method.uppercase() in setOf("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")) { "지원하지 않는 HTTP 메서드입니다." }
        val url = resolveAgentRelativeUrl(request.url, servlet)
        val node = mapper.convertValue(mapOf("id" to "oneoff", "type" to "http", "method" to request.method.uppercase(), "baseUrl" to url, "path" to "", "bodyType" to "raw", "rawBody" to request.body, "headersRaw" to true, "rawHeaders" to request.headers.entries.joinToString("\n") { "${it.key}: ${it.value}" }), GraphNode::class.java)
        require(request.headers.all { (k, v) -> !k.contains('\r') && !k.contains('\n') && !v.contains('\r') && !v.contains('\n') }) { "헤더에 줄바꿈을 넣을 수 없습니다." }
        executor.executeOneoff(node, request.timeoutSec)
    }
}

/** Relative Mock requests use the listener origin without following an administrative-origin redirect. */
internal fun resolveAgentRelativeUrl(url: String, servlet: jakarta.servlet.http.HttpServletRequest): String {
    if (!url.startsWith("/") || url.startsWith("//")) return url
    val host = if (url.startsWith("/mock/")) "localhost" else "127.0.0.1"
    return "http://$host:${servlet.localPort}${servlet.contextPath}$url"
}
