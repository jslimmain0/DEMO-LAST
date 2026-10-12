package com.flowlink.plugin

import com.flowlink.common.tenant.TenantContext
import com.flowlink.common.json.JsonService
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FlowVersionRepository
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.core.repository.ProtocolRepository
import com.flowlink.workspace.WorkspaceService
import com.flowlink.workspace.ResourceWorkspace
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Transactional
import java.util.concurrent.ConcurrentHashMap

/**
 * pluginId 사용처 — 워크플로(현재 그래프 transformId)·Mock(spec codec step id)·프로토콜(필드 plugin.id) 문자열 스캔.
 * 테넌트별 30초 캐시(MockServerService.usageIndex 관례). 삭제 가드·목록 카운트·승인 화면 경고에 쓴다.
 */
@Component
class PluginUsageIndex(
    private val flowRepo: FlowRepository,
    private val versionRepo: FlowVersionRepository,
    private val mockRepo: MockServerRepository,
    private val protocolRepo: ProtocolRepository,
    private val json: JsonService,
    private val workspace: WorkspaceService,
) {
    data class Ref(val kind: String, val id: String, val name: String)
    private data class Doc(val kind: String, val id: String, val name: String, val text: String,
        val ownerWorkspaceKey: String, val resourceWorkspaceKey: String, val protocolIds: Set<String>? = null)
    private val cache = ConcurrentHashMap<String, Pair<Long, List<Doc>>>()

    fun invalidate() = cache.clear()
    @Transactional(readOnly = true)
    fun count(pluginId: String, workspaceKey: String = "public", refresh: Boolean = false): Int = matching(pluginId, workspaceKey, refresh).size

    @Transactional(readOnly = true)
    fun refs(pluginId: String, workspaceKey: String = "public"): List<Ref> {
        val username = workspace.currentUsername()
        return matching(pluginId, workspaceKey).map { d ->
            val visible = runCatching { workspace.requireRead(username, ResourceWorkspace.id(d.ownerWorkspaceKey)) }.isSuccess
            if (visible) Ref(d.kind, d.id, d.name) else Ref(d.kind, "", "접근 권한 없는 " +
                when (d.kind) { "flow" -> "워크플로"; "mock" -> "Mock"; else -> "프로토콜" })
        }
    }

    private fun matching(pluginId: String, workspaceKey: String, refresh: Boolean = false): List<Doc> {
        if (pluginId.isBlank()) return emptyList()
        val q = Regex.escape(pluginId)
        val inFlow = Regex("\"transformId\"\\s*:\\s*\"$q\"")
        val inMock = Regex("\"id\"\\s*:\\s*\"$q\"")
        val inProto = Regex("\"plugin\"\\s*:\\s*\\{[^}]*\"id\"\\s*:\\s*\"$q\"")
        return docs(refresh).filter { it.resourceWorkspaceKey == workspaceKey }.filter { d ->
            when (d.kind) { "flow" -> inFlow.containsMatchIn(d.text); "mock" -> inMock.containsMatchIn(d.text);
                else -> d.protocolIds?.contains(pluginId) ?: inProto.containsMatchIn(d.text) }
        }
    }

    private fun document(kind: String, id: String, name: String, text: String, owner: String): Doc {
        val tree = runCatching { json.readTree(text) }.getOrNull()
        val resource = if (kind in setOf("flow", "mock") && tree?.path("resourceWorkspaceId")?.asText() == "public") "public" else owner
        val protocolIds = if (kind != "protocol" || tree == null) null else
            (tree.findValues("plugin") + tree.path("messagePlugins").toList()).mapNotNull { it.path("id").takeIf { id -> id.isTextual }?.asText() }.toSet()
        return Doc(kind, id, name, text, owner, resource, protocolIds)
    }

    private fun docs(refresh: Boolean = false): List<Doc> {
        val t = TenantContext.getTenantId()
        val now = System.currentTimeMillis()
        if (!refresh) cache[t]?.let { if (now - it.first < 30_000) return it.second }
        val flows = flowRepo.findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(TenantContext.SHARED_FLOW_TENANT)
        val graphs = if (flows.isEmpty()) emptyMap() else versionRepo.findCurrentByFlowIds(flows.map { it.id }).associateBy { it.flowId }
        val built = flows.mapNotNull { f -> graphs[f.id]?.graphJson?.let { document("flow", f.id.toString(), f.name, it, f.workspaceId?.toString() ?: "public") } } +
            mockRepo.findByTenantIdOrderByUpdatedAtDesc(t).mapNotNull { m -> m.specJson?.let { document("mock", m.id.toString(), m.name, it, m.workspaceId?.toString() ?: "public") } } +
            protocolRepo.findByTenantIdOrderByNameAsc(t).map { p -> document("protocol", p.id.toString(), p.name, p.specJson, p.workspaceKey) }
        cache[t] = now to built
        return built
    }
}
