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
    private val tcpSessions = com.flowlink.protocol.TcpSessionRegistry()
    private val tcpCleanup = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { Thread(it, "tcp-session-idle").apply { isDaemon = true } }.apply {
        scheduleWithFixedDelay({ tcpSessions.expireIdle() }, 5, 5, java.util.concurrent.TimeUnit.SECONDS)
    }
    fun closeTcpExecution(id: java.util.UUID, owner: List<String>? = null) = tcpSessions.closeExecution(id, com.flowlink.common.tenant.TenantContext.getTenantId(), owner)
    fun invalidateTcpExecution(id: java.util.UUID, owner: List<String>? = null) = tcpSessions.invalidateExecution(id, com.flowlink.common.tenant.TenantContext.getTenantId(), owner)
    @jakarta.annotation.PreDestroy
    fun closeTcpSessions() { tcpCleanup.shutdownNow(); tcpSessions.close() }

    val runtime: String get() = if (resources.localRuntime) "local" else "server"

    private fun ownerResources(node: GraphNode) = node.usesWorkflowContext() || node.reqMode == "client" || node.effectiveType() in setOf(NodeType.FORM, NodeType.INPUT, NodeType.WAIT)

    private data class Scopes(val owner: java.util.UUID?, val resource: java.util.UUID?, val identity: CentralResourceIdentity?, val shared: Boolean = false)

    private fun identity(value: CentralResourceIdentity?): CentralResourceIdentity = value?.takeIf { it.serverUrl.isNotBlank() }
        ?: throw BadRequestException("실행을 시작한 서버 연결 정보가 필요합니다.")

    private fun scopes(workspaceId: String?, resourceWorkspaceId: String?, resourceIdentity: CentralResourceIdentity?): Scopes {
        if (resourceWorkspaceId != null && resourceWorkspaceId != "public") throw BadRequestException("공통 자원 공간은 public만 선택할 수 있습니다.")
        val owner = resources.workspaceScope(workspaceId)
        if (resourceWorkspaceId == null) return Scopes(owner, owner, null)
        return if (runtime == "local") Scopes(owner, null, resourceIdentity?.takeIf { it.serverUrl.isNotBlank() }, shared = true)
        else Scopes(owner, resources.workspaceScope("public"), null, shared = true)
    }

    private fun environment(scope: java.util.UUID?, name: String?, source: String?, resourceIdentity: CentralResourceIdentity?, snapshot: Map<String, Any?>?, load: Boolean = true): Map<String, Any?> {
        if (source != null && source !in setOf("local", "server")) throw BadRequestException("알 수 없는 환경 출처입니다.")
        if (source == "server" && runtime == "local") return resources.centralEnvironment(name, identity(resourceIdentity))
        if (source == "local" && runtime == "server") return snapshot ?: throw BadRequestException("선택한 PC 환경의 실행 값이 필요합니다.")
        val destination = if (source == "server") resources.workspaceScope("public") else scope
        if (!load && !resources.environmentExists(name, destination)) throw BadRequestException("실행 에이전트에 선택한 환경이 없습니다: $name")
        return if (load) resources.environment(name, destination) else emptyMap()
    }

    private fun secrets(node: GraphNode, scope: Scopes, envName: String?, envSource: String?, includeProtocol: Boolean = true): Map<String, String> {
        val secretEnv = if (scope.shared && envSource == "local") null else envName
        if (!scope.shared || runtime != "local") return resources.secrets(secretEnv, scope.resource)
        val keys = AgentRequestBuilder.references(node, json).filter { it.source == "secret" }.map { it.key }.toMutableSet()
        if (includeProtocol && node.nodeType() == NodeType.TCP && !node.protocolId.isNullOrBlank()) keys.addAll(resources.centralProtocolSecretKeys(node.protocolId, identity(scope.identity)))
        return if (keys.isEmpty()) emptyMap() else resources.centralSecrets(secretEnv, keys, identity(scope.identity))
    }

    fun inspect(node: GraphNode, workspaceId: String?, envName: String?, resourceWorkspaceId: String? = null, resourceIdentity: CentralResourceIdentity? = null, envSource: String? = null, environmentSnapshot: Map<String, Any?>? = null): Map<String, String> {
        if (node.nodeType() == NodeType.TRANSFORM && runtime == "local") throw BadRequestException("플러그인은 중앙 서버에서만 실행합니다.")
        if (node.nodeType() != NodeType.TRANSFORM && !ownerResources(node) && (node.executionAgent ?: runtime) != runtime) throw BadRequestException("선택한 에이전트와 실제 실행 프로세스가 다릅니다.")
        val scope = scopes(workspaceId, resourceWorkspaceId, resourceIdentity)
        environment(scope.owner, envName, envSource, resourceIdentity, environmentSnapshot, load = false)
        if (!ownerResources(node) && !node.agentMock.isNullOrBlank()) resources.mockTarget(node.agentMock, scope.owner)
        val hashes = linkedMapOf<String, String>()
        if (node.nodeType() == NodeType.TCP) hashes["protocol"] = if (scope.shared && runtime == "local") resources.centralProtocolFingerprint(node.protocolId ?: "", identity(scope.identity))
            else resources.protocolFingerprint(node.protocolId ?: "", scope.resource)
        if (node.nodeType() == NodeType.TRANSFORM) hashes["transform"] = transforms.fingerprint(node.transformId ?: "", scope.resource)
            ?: throw BadRequestException("실행 에이전트에 선택한 변환 플러그인이 없습니다.")
        return hashes
    }

    fun targetDiagnostics(node: GraphNode, workspaceId: String?, envName: String?, resourceWorkspaceId: String? = null, resourceIdentity: CentralResourceIdentity? = null, envSource: String? = null, environmentSnapshot: Map<String, Any?>? = null): Map<String, Any?> {
        val node = if (node.usesWorkflowContext() || node.effectiveType() in setOf(NodeType.FORM, NodeType.INPUT, NodeType.WAIT)) node.copy(agentMock = null, executionAgent = runtime) else node
        val scope = scopes(workspaceId, resourceWorkspaceId, resourceIdentity)
        val env = environment(scope.owner, envName, envSource, resourceIdentity, environmentSnapshot)
        val secretValues = secrets(node, scope, envName, envSource, includeProtocol = false)
        val ctx = ExecutionContext().apply { this.workspaceId = scope.resource; this.resourceIdentity = scope.identity; putOutput("env", env); putSeed("secret", secretValues) }
        if (!node.agentMock.isNullOrBlank()) {
            if (node.reqMode == "client") throw BadRequestException("브라우저 요청에는 에이전트 Mock이 적용되지 않습니다. 요청 방식을 변경하세요.")
            val diagnostic = EndpointResolver.diagnostics(resolveMockNode(node, scope.owner), ctx, envName, tokens)
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

    fun execute(request: AgentNodeRequest, sessionOwner: List<String> = emptyList(), canSendTcp: () -> Boolean = { true }): AgentNodeResult {
        val started = System.nanoTime()
        val knownSecrets = linkedSetOf<String>()
        val result = try {
            val node = request.node
            if (node.nodeType() == NodeType.TRANSFORM && runtime == "local") throw BadRequestException("플러그인은 중앙 서버에서만 실행합니다.")
            if (node.executionAgent != runtime) throw BadRequestException("선택한 에이전트와 실제 실행 프로세스가 다릅니다.")
            // 이미 저장된 과거 계산 작업은 완료할 수 있다. 새 계산 작업은 builder에서 생성하지 않는다.
            if (node.effectiveType() !in setOf(NodeType.HTTP, NodeType.TCP, NodeType.SET, NodeType.IF, NodeType.ASSERT, NodeType.TRANSFORM))
                throw BadRequestException("에이전트에서 독립 실행할 수 없는 노드입니다.")
            if (node.reqMode == "client") throw BadRequestException("브라우저 요청은 에이전트 작업으로 실행할 수 없습니다.")
            if (request.values.containsKey("secret") || request.seeds.containsKey("secret") ||
                (request.crossBoundary && (request.values.containsKey("env") || request.seeds.containsKey("env")) &&
                    !(request.envSource == "local" && runtime == "server" && !request.values.containsKey("env") && request.seeds["env"] is Map<*, *>)))
                throw BadRequestException("환경·시크릿은 실행 에이전트에서 해석해야 합니다.")
            if (request.crossBoundary && request.envName == null && request.envSource == null) throw BadRequestException("목적지 환경을 명시적으로 선택하세요. 공통 환경은 빈 문자열로 선택합니다.")
            val scope = scopes(request.workspaceId, request.resourceWorkspaceId, request.resourceIdentity)
            @Suppress("UNCHECKED_CAST")
            val snapshot = (request.seeds["env"] as? Map<*, *>)?.takeIf { it.keys.all { key -> key is String } } as? Map<String, Any?>
            val hashes = inspect(node, request.workspaceId, request.envName, request.resourceWorkspaceId, request.resourceIdentity, request.envSource, snapshot)
            if (request.dependencyHashes.any { (key, hash) -> hashes[key] != hash })
                throw BadRequestException("전문·플러그인 버전이 실행 계획과 다릅니다. 자원을 확인한 후 다시 실행하세요.")
            val env = environment(scope.owner, request.envName, request.envSource, request.resourceIdentity, snapshot)
            val ctx = ExecutionContext().apply {
                tcpSessions = this@AgentNodeExecutor.tcpSessions
                borrowedTcpSessions = true
                this.canSendTcp = canSendTcp
                tcpSessionScope = com.flowlink.protocol.TcpSessionRegistry.Scope(request.executionId, com.flowlink.common.tenant.TenantContext.getTenantId(), sessionOwner,
                    request.workspaceId, request.resourceIdentity?.serverUrl, request.resourceIdentity?.login)
                workspaceId = scope.resource
                resourceIdentity = scope.identity
                expectedProtocolFingerprint = request.dependencyHashes["protocol"]
                // 환경은 가장 오래된 입력이다. 상위 노드 값이 bare 토큰에서 우선해야 한다.
                val resolvedEnv = if (request.envSource == null && request.envName.isNullOrBlank()) request.seeds["env"] ?: env else env
                restore(linkedMapOf<String, Any?>("env" to resolvedEnv).apply { putAll(request.values) }, request.seeds - "env")
            }
            val secretValues = secrets(node, scope, request.envName, request.envSource)
            knownSecrets.addAll(secretValues.values)
            ctx.putSeed("secret", secretValues)
            val resolved = resolveMockNode(node, scope.owner)
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
                    requestText = SecretMasker.mask(raw.requestText, masks),
                    responseText = if (raw.ok) AgentResultText.response(raw.value, value, json) else com.flowlink.protocol.TcpSessionRegistry.safeFailure(raw.responseText)
                        ?: "노드 실행 실패 · 상태 ${raw.httpStatus ?: "확인 불가"} · 허용 출력 ${json.toJson(value)}")
            } else raw.copy(storedValue = masked(raw.storedValue), requestText = SecretMasker.mask(raw.requestText, masks), responseText = SecretMasker.mask(raw.responseText, masks))
        } catch (e: Exception) {
            NodeResult.fail(null, "에이전트 준비 확인", SecretMasker.mask(e.message ?: "노드 실행을 준비하지 못했습니다.", SecretMasker.variants(knownSecrets)))
        }
        if (!result.ok || result.uncertain) invalidateTcpExecution(request.executionId, sessionOwner)
        return AgentNodeResult(result, (System.nanoTime() - started) / 1_000_000)
    }
}
