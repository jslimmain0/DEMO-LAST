package com.flowlink.plugin

import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FlowVersionRepository
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.core.repository.ProtocolRepository
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
) {
    data class Ref(val kind: String, val id: String, val name: String)
    private data class Doc(val kind: String, val id: String, val name: String, val text: String)
    private val cache = ConcurrentHashMap<String, Pair<Long, List<Doc>>>()

    fun invalidate() = cache.clear()
    fun count(pluginId: String): Int = refs(pluginId).size

    @Transactional(readOnly = true)
    fun refs(pluginId: String): List<Ref> {
        if (pluginId.isBlank()) return emptyList()
        val q = Regex.escape(pluginId)
        val inFlow = Regex("\"transformId\"\\s*:\\s*\"$q\"")
        val inMock = Regex("\"id\"\\s*:\\s*\"$q\"")
        val inProto = Regex("\"plugin\"\\s*:\\s*\\{[^}]*\"id\"\\s*:\\s*\"$q\"")
        return docs().filter { d ->
            when (d.kind) { "flow" -> inFlow.containsMatchIn(d.text); "mock" -> inMock.containsMatchIn(d.text); else -> inProto.containsMatchIn(d.text) }
        }.map { Ref(it.kind, it.id, it.name) }
    }

    private fun docs(): List<Doc> {
        val t = TenantContext.getTenantId()
        val now = System.currentTimeMillis()
        cache[t]?.let { if (now - it.first < 30_000) return it.second }
        val flows = flowRepo.findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(t)
        val graphs = if (flows.isEmpty()) emptyMap() else versionRepo.findCurrentByFlowIds(flows.map { it.id }).associateBy { it.flowId }
        val built = flows.mapNotNull { f -> graphs[f.id]?.graphJson?.let { Doc("flow", f.id.toString(), f.name, it) } } +
            mockRepo.findByTenantIdOrderByUpdatedAtDesc(t).mapNotNull { m -> m.specJson?.let { Doc("mock", m.id.toString(), m.name, it) } } +
            protocolRepo.findByTenantIdOrderByNameAsc(t).map { p -> Doc("protocol", p.id.toString(), p.name, p.specJson) }
        cache[t] = now to built
        return built
    }
}
