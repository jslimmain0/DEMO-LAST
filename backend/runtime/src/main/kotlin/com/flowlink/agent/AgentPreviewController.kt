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
) {
    data class Inspection(val node: GraphNode, val workspaceId: String? = null, val envName: String? = null)
    @PostMapping("/inspect")
    fun inspect(@RequestBody body: Inspection): Map<String, Any> {
        val scope = workspace.resolveId(body.workspaceId)
        workspace.requireWrite(workspace.currentUsername(), scope)
        return try {
            mapOf("runtime" to executor.runtime, "ready" to true, "issues" to emptyList<String>(),
                "dependencyHashes" to executor.inspect(body.node, body.workspaceId, body.envName),
                "targetDiagnostics" to executor.targetDiagnostics(body.node, body.workspaceId, body.envName))
        } catch (e: IllegalArgumentException) {
            mapOf("runtime" to executor.runtime, "ready" to false, "issues" to listOf(e.message ?: "자원 준비를 확인하세요."))
        } catch (e: RuntimeException) {
            mapOf("runtime" to executor.runtime, "ready" to false, "issues" to listOf(e.message ?: "자원 준비를 확인하세요."))
        }
    }
    @PostMapping("/tcp-preview")
    fun tcp(@RequestBody node: GraphNode, @RequestParam(required = false) workspaceId: String?, @RequestParam(required = false) envName: String?) : com.flowlink.protocol.ProtocolDtos.PreviewResult {
        val scope = workspace.resolveId(workspaceId)
        workspace.requireWrite(workspace.currentUsername(), scope)
        if (!environments.exists(envName, scope)) throw IllegalArgumentException("선택한 환경이 없습니다.")
        return engine.previewTcp(node, scope, environments.vars(envName, scope), secrets.activeSecrets(envName, scope))
    }
}
