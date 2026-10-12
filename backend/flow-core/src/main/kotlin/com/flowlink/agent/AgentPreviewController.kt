package com.flowlink.agent

import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.engine.FlowExecutor
import com.flowlink.workspace.WorkspaceService
import org.springframework.web.bind.annotation.*

/** 선택 에이전트의 자원으로 검증/인코딩한다. 다른 저장소의 flow ID를 복제하지 않는다. */
@RestController
@RequestMapping("/api/v1/agent")
class AgentPreviewController(
    private val executor: AgentNodeExecutor, private val engine: FlowExecutor, private val workspace: WorkspaceService,
    private val environments: com.flowlink.environment.EnvironmentService,
    private val secrets: com.flowlink.secret.SecretService,
    private val connection: org.springframework.beans.factory.ObjectProvider<com.flowlink.common.host.LocalServerConnection>,
    private val central: org.springframework.beans.factory.ObjectProvider<com.flowlink.common.host.LocalServerResources>,
) {
    data class Inspection(val node: GraphNode, val workspaceId: String? = null, val envName: String? = null,
        val resourceWorkspaceId: String? = null, val resourceIdentity: CentralResourceIdentity? = null,
        val envSource: String? = null, val env: Map<String, Any?>? = null)
    @PostMapping("/inspect")
    fun inspect(@RequestBody body: Inspection): Map<String, Any> {
        val scope = workspace.resolveId(body.workspaceId)
        workspace.requireWrite(workspace.currentUsername(), scope)
        val identity = identity(body.resourceIdentity)
        return try {
            mapOf("runtime" to executor.runtime, "ready" to true, "issues" to emptyList<String>(),
                "dependencyHashes" to executor.inspect(body.node, body.workspaceId, body.envName, body.resourceWorkspaceId, identity, body.envSource, body.env),
                "targetDiagnostics" to executor.targetDiagnostics(body.node, body.workspaceId, body.envName, body.resourceWorkspaceId, identity, body.envSource, body.env))
        } catch (e: IllegalArgumentException) {
            mapOf("runtime" to executor.runtime, "ready" to false, "issues" to listOf(e.message ?: "자원 준비를 확인하세요."))
        } catch (e: RuntimeException) {
            mapOf("runtime" to executor.runtime, "ready" to false, "issues" to listOf(e.message ?: "자원 준비를 확인하세요."))
        }
    }
    @PostMapping("/tcp-preview")
    fun tcp(@RequestBody node: GraphNode, @RequestParam(required = false) workspaceId: String?, @RequestParam(required = false) envName: String?,
        @RequestParam(required = false) resourceWorkspaceId: String? = null, @RequestParam(required = false) envSource: String? = null) : com.flowlink.protocol.ProtocolDtos.PreviewResult =
        tcpResources(Inspection(node, workspaceId, envName, resourceWorkspaceId, envSource = envSource))

    @PostMapping("/tcp-preview/resources")
    fun tcpResources(@RequestBody body: Inspection): com.flowlink.protocol.ProtocolDtos.PreviewResult {
        val (node, workspaceId, envName, resourceWorkspaceId) = body
        val envSource = body.envSource
        val scope = workspace.resolveId(workspaceId)
        workspace.requireWrite(workspace.currentUsername(), scope)
        if (resourceWorkspaceId != null && resourceWorkspaceId != "public") throw IllegalArgumentException("서버 공통 자원 공간을 선택하세요.")
        if (envSource != null && envSource !in setOf("local", "server")) throw IllegalArgumentException("알 수 없는 환경 출처입니다.")
        val identity = if (resourceWorkspaceId == "public" && workspace.localRuntime) identity(body.resourceIdentity) else null
        val envScope = if (envSource == "server") null else scope
        val vars = if (envSource == "local" && !workspace.localRuntime) body.env?.mapValues { it.value?.toString().orEmpty() }
            ?: throw IllegalArgumentException("PC 환경 변수 묶음이 필요합니다.")
            else if (envSource == "server" && workspace.localRuntime) central.getObject().environment(envName, identity ?: identity(null)!!)
            else { if (!environments.exists(envName, envScope)) throw IllegalArgumentException("선택한 환경이 없습니다."); environments.vars(envName, envScope) }
        val resourceScope = if (resourceWorkspaceId == "public") null else scope
        val secretEnvironment = if (resourceWorkspaceId == "public" && envSource == "local") null else envName
        val values = if (identity == null) secrets.activeSecrets(secretEnvironment, resourceScope) else {
            val refs = com.flowlink.execution.engine.TokenResolver.tokenPattern()
            val keys = linkedSetOf<String>()
            fun scan(raw: String) { val matcher = refs.matcher(raw); while (matcher.find()) if (matcher.group(3) == "secret") keys.add(matcher.group(1)) }
            scan(node.toString()); scan(central.getObject().protocolSpec(node.protocolId.orEmpty(), identity).toString())
            central.getObject().secrets(secretEnvironment, keys, identity)
        }
        return engine.previewTcp(node, resourceScope, vars, values, identity)
    }

    private fun identity(supplied: CentralResourceIdentity?): CentralResourceIdentity? = if (workspace.localRuntime) {
        connection.getObject().connectionIdentity().let {
            val active = CentralResourceIdentity(it.serverUrl, it.login)
            if (supplied != null && supplied != active) throw com.flowlink.common.error.BadRequestException("서버 또는 계정이 변경되었습니다. 실행 계획을 다시 확인하세요.")
            active
        }
    } else supplied
}
