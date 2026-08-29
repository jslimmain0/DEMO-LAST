package com.flowlink.definition

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Flow
import com.flowlink.core.domain.FlowVersion
import com.flowlink.core.graph.GraphValidator
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FlowVersionRepository
import com.flowlink.definition.dto.CreateFlowRequest
import com.flowlink.definition.dto.FlowDetail
import com.flowlink.definition.dto.FlowSummary
import com.flowlink.definition.dto.FlowVersionSummary
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

/** 워크플로 정의(메타데이터 + 불변 버전) 관리. */
@Service
class FlowService(
    private val flowRepo: FlowRepository,
    private val versionRepo: FlowVersionRepository,
    private val folderRepo: com.flowlink.core.repository.FolderRepository,
    private val json: JsonService,
    private val validator: GraphValidator,
    private val workspace: com.flowlink.workspace.WorkspaceService,
) {
    private val mapper: ObjectMapper = json.mapper()

    // 워크스페이스 롤 게이트 — 읽기(VIEWER+)/쓰기(EDITOR+). 공용(null)은 모두 편집 가능(기존 호환).
    private fun readable(flow: Flow): Flow { workspace.requireRead(workspace.currentUsername(), flow.workspaceId); return flow }
    private fun writable(flow: Flow): Flow { workspace.requireWrite(workspace.currentUsername(), flow.workspaceId); return flow }

    @Transactional(readOnly = true)
    fun list(workspaceIdRaw: String? = null): List<FlowSummary> {
        val wsId = workspace.resolveId(workspaceIdRaw)
        workspace.requireRead(workspace.currentUsername(), wsId)
        val flows = if (wsId == null)
            flowRepo.findByTenantIdAndArchivedFalseAndWorkspaceIdIsNullOrderByUpdatedAtDesc(tenant())
        else
            flowRepo.findByTenantIdAndArchivedFalseAndWorkspaceIdOrderByUpdatedAtDesc(tenant(), wsId)
        if (flows.isEmpty()) return emptyList()
        // 캐시 미스인 flow 만 현재 버전 그래프를 1 쿼리로 일괄 조회 — flow 별 재조회 N+1 제거 + 반복 파싱 제거
        val missing = flows.filter { summaryCache[it.id]?.versionNo != it.currentVersion }.map { it.id }
        val graphByFlow = if (missing.isEmpty()) emptyMap()
        else versionRepo.findCurrentByFlowIds(missing).associateBy { it.flowId }
        return flows.map { summaryOf(it, graphByFlow[it.id]?.graphJson) }
    }

    /**
     * 그래프 요약(노드 수/타입/검색 텍스트) 캐시 — 그래프는 **버전별 불변**이라 (flowId, versionNo) 키로 안전.
     * 목록 요청마다 flow 당 1.7KB JSON 파싱을 반복하던 것이 지배 비용이었음(100개 목록 기준 ~15ms → ~0).
     * 버전이 바뀌면 키 불일치로 자연 무효화(별도 무효화 코드 불필요), 단일 인스턴스 스코프.
     */
    private data class GraphDigest(val versionNo: Int, val count: Int, val types: List<String>, val cats: List<String>, val blob: String?)
    private val summaryCache = java.util.concurrent.ConcurrentHashMap<UUID, GraphDigest>()

    // 목록 카드 미리보기 + 내용 검색을 위해 현재 버전 그래프에서 노드 요약을 뽑는다(그래프는 목록 쿼리에서 일괄 전달).
    private fun summaryOf(flow: Flow, graphJson: String? = null): FlowSummary {
        val cached = summaryCache[flow.id]?.takeIf { it.versionNo == flow.currentVersion }
        val digest = cached ?: run {
            val types = ArrayList<String>()
            val cats = ArrayList<String>()
            val text = StringBuilder()
            var count = 0
            try {
                val graph = if (graphJson != null) json.readTree(graphJson) else currentGraph(flow)
                val nodes = graph.get("nodes")
                if (nodes != null && nodes.isArray) {
                    for (n in nodes) {
                        val t = n.get("type")?.asText() ?: continue
                        if (t == "note" || t == "group") continue
                        count++
                        if (types.size < 12) {
                            types.add(t)
                            cats.add(n.get("cat")?.asText()?.takeIf { it.isNotBlank() } ?: t)
                        }
                        if (text.length < 600) {
                            for (fld in SEARCH_FIELDS) {
                                val v = n.get(fld)?.asText()
                                if (!v.isNullOrBlank()) text.append(v).append(' ')
                            }
                        }
                    }
                }
            } catch (_: Exception) { /* 손상 그래프는 요약 없이 넘어감 */ }
            val d = GraphDigest(flow.currentVersion, count, types, cats, text.toString().trim().lowercase().take(700).ifBlank { null })
            summaryCache[flow.id] = d
            if (summaryCache.size > 5000) summaryCache.clear() // 폭주 방지(재계산 저렴)
            d
        }
        return FlowSummary(
            flow.id, flow.name, flow.description, flow.currentVersion, flow.folderId, flow.updatedAt,
            digest.count, digest.types, digest.cats, digest.blob
        )
    }

    @Transactional(readOnly = true)
    fun get(id: UUID): FlowDetail = toDetail(loadFlow(id))

    @Transactional
    fun create(req: CreateFlowRequest): FlowDetail {
        val wsId = workspace.resolveId(req.workspaceId)
        workspace.requireWrite(workspace.currentUsername(), wsId)
        requireFolderInWorkspace(req.folderId, wsId)
        val flow = createInternal(req.name, req.description, emptyGraph(req.name), "초기 버전", req.folderId)
        flow.workspaceId = wsId
        return toDetail(flow)
    }

    @Transactional
    fun moveToFolder(id: UUID, folderId: UUID?) {
        val flow = writable(loadFlow(id))
        requireFolderInWorkspace(folderId, flow.workspaceId)
        flow.folderId = folderId
    }

    /** 폴더-워크스페이스 교차 배치 방지 — 다른 ws 폴더에 넣으면 어느 화면에도 안 보이는 고아 flow 가 된다. */
    private fun requireFolderInWorkspace(folderId: UUID?, wsId: UUID?) {
        if (folderId == null) return
        val folder = folderRepo.findByIdAndTenantId(folderId, tenant())
            .orElseThrow { NotFoundException.of("Folder", folderId) }
        if (folder.workspaceId != wsId) {
            throw com.flowlink.common.error.BadRequestException("다른 워크스페이스의 폴더에는 넣을 수 없습니다.")
        }
    }

    @Transactional
    fun updateMeta(id: UUID, name: String?, description: String?): FlowDetail {
        val flow = writable(loadFlow(id))
        name?.takeIf { it.isNotBlank() }?.let { flow.name = it }
        if (description != null) flow.description = description
        return toDetail(flow)
    }

    @Transactional
    fun archive(id: UUID) {
        writable(loadFlow(id)).archived = true
    }

    @Transactional
    fun saveVersion(id: UUID, graph: JsonNode, note: String?, pinned: Boolean = false): FlowVersionSummary {
        val flow = writable(loadFlow(id))
        val graphJson = json.toJson(graph)
        val parsed = json.parseGraph(graphJson)
        validator.validate(parsed)

        val gname = parsed.name
        val name = if (gname != null && gname.isNotBlank()) gname else flow.name
        val nextNo = flow.currentVersion + 1

        val version = FlowVersion.create(flow.id, nextNo, name, graphJson, note, currentUser())
        if (pinned) version.pinned = true // 📌 보존 버전(커밋) — retention 정리에서 영구 제외
        // 할당식 UUID 엔티티는 save 가 merge 로 동작 → @CreationTimestamp lateinit createdAt 은
        // **반환된 관리 인스턴스**에만 채워진다(원본 version 은 merge 소스라 미초기화). from 이 createdAt
        // 을 읽으므로 반환값(saved)을 써야 한다. createInternal 의 `flow = saveAndFlush(flow)` 와 동일 이유.
        val saved = versionRepo.saveAndFlush(version)

        flow.name = name
        flow.currentVersion = nextNo
        return FlowVersionSummary.from(saved)
    }

    /** 📌 보존 토글 — 커밋처럼 남긴 버전을 자동 정리에서 제외(해제 시 다시 정리 대상). */
    @Transactional
    fun setVersionPinned(id: UUID, versionNo: Int, pinned: Boolean): FlowVersionSummary {
        writable(loadFlow(id))
        val v = versionRepo.findByFlowIdAndVersionNo(id, versionNo)
            .orElseThrow { NotFoundException.of("FlowVersion", versionNo) }
        v.pinned = pinned
        return FlowVersionSummary.from(versionRepo.saveAndFlush(v))
    }

    /** 버전 기록(최신 우선) — 테넌트 소유 확인 후. */
    @Transactional(readOnly = true)
    fun listVersions(id: UUID): List<FlowVersionSummary> {
        loadFlow(id) // 테넌트 소유 확인(없으면 404)
        return versionRepo.findByFlowIdOrderByVersionNoDesc(id).map { FlowVersionSummary.from(it) }
    }

    /** 특정 버전의 그래프 JSON — 미리보기/diff 용. */
    @Transactional(readOnly = true)
    fun getVersionGraph(id: UUID, versionNo: Int): JsonNode {
        loadFlow(id)
        val v = versionRepo.findByFlowIdAndVersionNo(id, versionNo)
            .orElseThrow { NotFoundException.of("FlowVersion", versionNo) }
        return json.readTree(v.graphJson)
    }

    /**
     * 과거 버전을 **새 버전으로 복원**(불변 이력 유지 — 되돌린 것도 새 스냅샷). currentVersion 이 그 그래프로 갱신된다.
     * 되돌리기 자체가 감사 로그에 남아 팀 협업에서 안전하다.
     */
    @Transactional
    fun restoreVersion(id: UUID, versionNo: Int): FlowVersionSummary {
        val flow = writable(loadFlow(id))
        val src = versionRepo.findByFlowIdAndVersionNo(id, versionNo)
            .orElseThrow { NotFoundException.of("FlowVersion", versionNo) }
        val nextNo = flow.currentVersion + 1
        val note = "v$versionNo 복원"
        val restored = FlowVersion.create(flow.id, nextNo, src.name, src.graphJson, note, currentUser())
        val saved = versionRepo.saveAndFlush(restored)
        flow.name = src.name
        flow.currentVersion = nextNo
        return FlowVersionSummary.from(saved)
    }

    @Transactional
    fun importFlow(export: JsonNode): FlowDetail {
        // 가져오기/복제도 현재 워크스페이스로 — payload 의 workspaceId('public'/없음=공용)
        val wsId = workspace.resolveId(export.get("workspaceId")?.asText()?.takeIf { it.isNotBlank() })
        workspace.requireWrite(workspace.currentUsername(), wsId)
        val name = textOr(export, "name", "가져온 플로우")
        val graph: ObjectNode = mapper.createObjectNode()
        graph.put("name", name)
        graph.set<JsonNode>("nodes", if (export.has("nodes")) export.get("nodes") else mapper.createArrayNode())
        graph.set<JsonNode>("edges", if (export.has("edges")) export.get("edges") else mapper.createArrayNode())

        // 가져온 그래프를 검증한 뒤 v1 으로 적재
        val parsed = json.parseGraph(json.toJson(graph))
        validator.validate(parsed)

        val flow = createInternal(name, textOr(export, "desc", ""), json.toJson(graph), "가져오기", null)
        flow.workspaceId = wsId
        return toDetail(flow)
    }

    // --- 내부 ---

    private fun createInternal(
        name: String, description: String?, initialGraphJson: String,
        note: String?, folderId: UUID?
    ): Flow {
        var flow = Flow.create(tenant(), name, description)
        // 할당식 UUID 엔티티는 save()가 merge로 동작하므로, save 이후의 변경이 누락되지 않도록
        // currentVersion 을 저장 전에 확정한다(항상 v1 을 함께 생성). saveAndFlush 로 INSERT 를 즉시
        // 반영해 @CreationTimestamp/@UpdateTimestamp 가 채워진 관리 인스턴스를 반환한다.
        flow.currentVersion = 1
        flow.folderId = folderId
        flow = flowRepo.saveAndFlush(flow)
        val v1 = FlowVersion.create(flow.id, 1, name, initialGraphJson, note, null)
        versionRepo.save(v1)
        return flow
    }

    private fun loadFlow(id: UUID): Flow =
        readable(
            flowRepo.findByIdAndTenantId(id, tenant())
                .orElseThrow { NotFoundException.of("Flow", id) }
        )

    private fun currentGraph(flow: Flow): JsonNode {
        if (flow.currentVersion <= 0) {
            return json.readTree(emptyGraph(flow.name))
        }
        return versionRepo.findByFlowIdAndVersionNo(flow.id, flow.currentVersion)
            .map { json.readTree(it.graphJson) }
            .orElseGet { json.readTree(emptyGraph(flow.name)) }
    }

    private fun toDetail(flow: Flow): FlowDetail =
        FlowDetail(
            flow.id, flow.name, flow.description,
            flow.currentVersion, flow.folderId, flow.createdAt, flow.updatedAt, currentGraph(flow),
            flow.workspaceId, workspace.roleFor(workspace.currentUsername(), flow.workspaceId)
        )

    private fun emptyGraph(name: String): String {
        val g: ObjectNode = mapper.createObjectNode()
        g.put("name", name)
        g.set<JsonNode>("nodes", mapper.createArrayNode())
        g.set<JsonNode>("edges", mapper.createArrayNode())
        return json.toJson(g)
    }

    companion object {
        // 노드 내용 검색 대상 필드 — 이름/URL/경로/폼URL/변환/조건
        private val SEARCH_FIELDS = listOf("name", "baseUrl", "path", "formAction", "transformId", "condition")
        private fun textOr(node: JsonNode, field: String, fallback: String): String {
            val v = node.get(field)
            return if (v != null && v.isTextual && !v.asText().isBlank()) v.asText() else fallback
        }

        // 워크플로우(flow/flow_version)는 전역 공유 — 로그인 테넌트가 아니라 공유 테넌트로 저장·조회.
        private fun tenant(): String = TenantContext.SHARED_FLOW_TENANT

        // OIDC 모드면 name=preferred_username(없으면 sub), dev 모드는 null — 버전 작성자 기록용.
        private fun currentUser(): String? {
            val auth = SecurityContextHolder.getContext().authentication
            return if (auth is JwtAuthenticationToken) auth.name else null
        }
    }
}
