package com.flowlink.agent

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.NodeType
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.engine.*
import com.flowlink.transform.TransformRegistry
import org.springframework.stereotype.Component

/** HTTP/TCP/변환은 이 프로세스에서 실행하며 시크릿을 해석한 컨텍스트를 전송하지 않는다. */
@Component
class AgentNodeExecutor(
    private val engine: FlowExecutor, private val resources: AgentResources,
    private val json: JsonService, private val tokens: TokenResolver,
    private val transforms: TransformRegistry,
) {
    val runtime: String get() = if (resources.localRuntime) "local" else "server"

    private fun ownerResources(node: GraphNode) = node.usesWorkflowContext() || node.reqMode == "client" || node.effectiveType() in setOf(NodeType.FORM, NodeType.INPUT, NodeType.WAIT)

    fun inspect(node: GraphNode, workspaceId: String?, envName: String?): Map<String, String> {
        if (node.nodeType() == NodeType.TRANSFORM && runtime == "local") throw BadRequestException("플러그인은 중앙 서버에서만 실행합니다.")
        if (node.nodeType() != NodeType.TRANSFORM && !ownerResources(node) && (node.executionAgent ?: runtime) != runtime) throw BadRequestException("선택한 에이전트와 실제 실행 프로세스가 다릅니다.")
        val scope = resources.workspaceScope(workspaceId)
        if (!resources.environmentExists(envName, scope)) throw BadRequestException("실행 에이전트에 선택한 환경이 없습니다: $envName")
        if (!ownerResources(node) && !node.agentMock.isNullOrBlank()) resources.mockTarget(node.agentMock, scope)
        val hashes = linkedMapOf<String, String>()
        if (node.nodeType() == NodeType.TCP) hashes["protocol"] = resources.protocolFingerprint(node.protocolId ?: "", scope)
        if (node.nodeType() == NodeType.TRANSFORM) hashes["transform"] = transforms.fingerprint(node.transformId ?: "", scope)
            ?: throw BadRequestException("실행 에이전트에 선택한 변환 플러그인이 없습니다.")
        return hashes
    }

    fun targetDiagnostics(node: GraphNode, workspaceId: String?, envName: String?): Map<String, Any?> {
        val node = if (node.usesWorkflowContext() || node.effectiveType() in setOf(NodeType.FORM, NodeType.INPUT, NodeType.WAIT)) node.copy(agentMock = null, executionAgent = runtime) else node
        val scope = resources.workspaceScope(workspaceId)
        val ctx = ExecutionContext().apply { putOutput("env", resources.environment(envName, scope)); putSeed("secret", resources.secrets(envName, scope)) }
        if (!node.agentMock.isNullOrBlank()) {
            if (node.reqMode == "client") throw BadRequestException("브라우저 요청에는 에이전트 Mock이 적용되지 않습니다. 요청 방식을 변경하세요.")
            val diagnostic = EndpointResolver.diagnostics(resolveMockNode(node, scope), ctx, envName, tokens)
            return diagnostic + mapOf("source" to if (diagnostic["source"] == "upstream-binding") "upstream-binding" else "destination-mock", "requester" to "agent",
                "warnings" to ((diagnostic["warnings"] as? List<*>).orEmpty().filterNot { it == "고정 주소는 실행 위치에 맞게 자동 치환되지 않습니다." } + "동일 실행기의 Mock입니다. 외부 콜백 도달성은 별도 확인하세요."))
        }
        return EndpointResolver.diagnostics(node, ctx, envName, tokens)
    }

    /** Diagnostics and execution must use the same explicit Mock target. Keep graph path unchanged. */
    private fun resolveMockNode(node: GraphNode, scope: java.util.UUID?): GraphNode {
        if (node.agentMock.isNullOrBlank()) return node
        val target = resources.mockTarget(node.agentMock, scope)
        return when (node.nodeType()) {
            NodeType.HTTP -> node.copy(baseUrl = target.baseUrl, baseUrlBound = null)
            NodeType.TCP -> node.copy(tcpHost = target.tcpHost ?: throw BadRequestException("TCP Mock 리스너가 없습니다."), tcpPort = target.tcpPort, tcpPortEnvKey = null)
            else -> throw BadRequestException("Mock은 HTTP/TCP 노드에서 선택하세요.")
        }
    }

    fun execute(request: AgentNodeRequest): AgentNodeResult {
        val started = System.nanoTime()
        val result = try {
            val node = request.node
            if (node.nodeType() == NodeType.TRANSFORM && runtime == "local") throw BadRequestException("플러그인은 중앙 서버에서만 실행합니다.")
            if (node.executionAgent != runtime) throw BadRequestException("선택한 에이전트와 실제 실행 프로세스가 다릅니다.")
            // 이미 저장된 과거 계산 작업은 완료할 수 있다. 새 계산 작업은 builder에서 생성하지 않는다.
            if (node.effectiveType() !in setOf(NodeType.HTTP, NodeType.TCP, NodeType.SET, NodeType.IF, NodeType.ASSERT, NodeType.TRANSFORM))
                throw BadRequestException("에이전트에서 독립 실행할 수 없는 노드입니다.")
            if (node.reqMode == "client") throw BadRequestException("브라우저 요청은 에이전트 작업으로 실행할 수 없습니다.")
            if (request.values.containsKey("secret") || request.seeds.containsKey("secret") ||
                (request.crossBoundary && (request.values.containsKey("env") || request.seeds.containsKey("env"))))
                throw BadRequestException("환경·시크릿은 실행 에이전트에서 해석해야 합니다.")
            if (request.crossBoundary && request.envName == null) throw BadRequestException("목적지 환경을 명시적으로 선택하세요. 공통 환경은 빈 문자열로 선택합니다.")
            val scope = resources.workspaceScope(request.workspaceId)
            val hashes = inspect(node, request.workspaceId, request.envName)
            if (request.dependencyHashes.any { (key, hash) -> hashes[key] != hash })
                throw BadRequestException("전문·플러그인 버전이 실행 계획과 다릅니다. 자원을 확인한 후 다시 실행하세요.")
            val env = resources.environment(request.envName, scope)
            val ctx = ExecutionContext().apply {
                workspaceId = scope
                // 환경은 가장 오래된 입력이다. 상위 노드 값이 bare 토큰에서 우선해야 한다.
                val resolvedEnv = if (request.envName.isNullOrBlank()) request.seeds["env"] ?: env else env
                restore(linkedMapOf<String, Any?>("env" to resolvedEnv).apply { putAll(request.values) }, request.seeds - "env")
            }
            val secretValues = resources.secrets(request.envName, scope)
            ctx.putSeed("secret", secretValues)
            val resolved = resolveMockNode(node, scope)
            tokens.requireResourceReferences(resolved, ctx)
            val raw = engine.runSingleNode(resolved, ctx)
            val maskValues = secretValues.values.toMutableList()
            for (v in node.vars.orEmpty().filter { it.secret }) {
                (raw.value as? Map<*, *>)?.get(v.key)?.let { maskValues.add(tokens.stringify(it)) }
            }
            val masks = SecretMasker.variants(maskValues)
            fun masked(value: Any?): Any? = when (value) {
                null -> null
                is Map<*, *> -> value.entries.associate { SecretMasker.mask(it.key.toString(), masks) to masked(it.value) }
                is Collection<*> -> value.map { masked(it) }
                is String -> SecretMasker.mask(value, masks)
                else -> value.toString().let { val safe = SecretMasker.mask(it, masks); if (safe == it) value else safe }
            }
            if (request.crossBoundary) {
                fun selected(value: Any?, keys: List<String>): Map<String, Any?> {
                    val source = ExecutionContext().apply { putOutput("result", value) }
                    return keys.associateWith { tokens.resolveTokenObject(it, false, "result", source) }
                }
                @Suppress("UNCHECKED_CAST")
                val value = masked(selected(raw.value, request.allowedOutputs)) as Map<String, Any?>
                @Suppress("UNCHECKED_CAST")
                val req = masked(selected(raw.reqValues, request.allowedRequestKeys)) as? Map<String, Any?>
                raw.copy(value = value, storedValue = value, reqValues = req,
                    requestText = "${node.type} · $runtime 에이전트 · ${node.name.orEmpty()}",
                    responseText = if (raw.ok) AgentResultText.response(raw.value, value, json) else "노드 실행 실패 · 상태 ${raw.httpStatus ?: "확인 불가"} · 허용 출력 ${json.toJson(value)}")
            } else raw.copy(storedValue = masked(raw.storedValue), requestText = SecretMasker.mask(raw.requestText, masks), responseText = SecretMasker.mask(raw.responseText, masks))
        } catch (e: Exception) {
            NodeResult.fail(null, "에이전트 준비 확인", e.message ?: "노드 실행을 준비하지 못했습니다.")
        }
        return AgentNodeResult(result, (System.nanoTime() - started) / 1_000_000)
    }
}
