package com.flowlink.workspace

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Flow
import com.flowlink.core.domain.FlowVersion
import com.flowlink.core.domain.Folder
import com.flowlink.core.domain.MockServer
import com.flowlink.core.graph.GraphValidator
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FlowVersionRepository
import com.flowlink.core.repository.FolderRepository
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.mock.MockServerService
import com.flowlink.mock.TcpMockRegistry
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.Locale
import java.util.UUID

/**
 * 워크스페이스 단위 export/import — 안의 **폴더 트리 + 워크플로(현재 버전 그래프) + Mock 서버(spec)** 를
 * 한 덩어리 JSON 텍스트로 내보내고, 붙여넣어 다른 워크스페이스/인스턴스로 통째로 가져온다.
 *
 * 규약:
 *  - 포맷 `{ kind:"flowlink-workspace", version:1, name, folders[{ref,name,parentRef}], flows[{name,desc,folderRef,graph}], mocks[...] }`
 *  - import 는 전부 **새 id** 로 생성(원본 불변). 폴더 참조는 ref 로 재매핑.
 *  - mock slug 가 이미 있으면 `-2`,`-3`… 접미사로 자동 개명(서빙 주소가 전역 유일이라 충돌 불가피 — 결과에 보고).
 *  - TCP mock 은 **꺼진 상태로** 가져온다(포트가 전역 자원이라 조용한 충돌 대신 사용자가 포트 확인 후 켜게).
 */
@Service
class WorkspaceTransferService(
    private val workspace: WorkspaceService,
    private val flowRepo: FlowRepository,
    private val versionRepo: FlowVersionRepository,
    private val folderRepo: FolderRepository,
    private val mockRepo: MockServerRepository,
    private val mockService: MockServerService,
    private val tcpRegistry: TcpMockRegistry,
    private val json: JsonService,
    private val validator: GraphValidator,
) {
    private val log = LoggerFactory.getLogger(WorkspaceTransferService::class.java)
    private val mapper = json.mapper()

    private fun tenant(): String = TenantContext.SHARED_FLOW_TENANT

    // ── export ─────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    fun export(workspaceIdRaw: String?): JsonNode {
        val wsId = workspace.resolveId(workspaceIdRaw)
        workspace.requireRead(workspace.currentUsername(), wsId)
        val wsName = if (wsId == null) "공용"
        else workspace.listMine().find { it.id == wsId.toString() }?.name ?: "워크스페이스"

        val root = mapper.createObjectNode()
        root.put("kind", "flowlink-workspace")
        root.put("version", 1)
        root.put("name", wsName)
        root.put("exportedAt", Instant.now().toString())

        // 폴더 — ref 로 트리 관계 직렬화(새 인스턴스에서 id 가 달라져도 부모 관계 유지)
        val folders = folderRepo.findByTenantIdOrderByNameAsc(tenant()).filter { it.workspaceId == wsId }
        val refOf = HashMap<UUID, String>()
        folders.forEachIndexed { i, f -> refOf[f.id] = "f${i + 1}" }
        val folderArr = root.putArray("folders")
        for (f in folders) {
            val o = folderArr.addObject()
            o.put("ref", refOf[f.id])
            o.put("name", f.name)
            f.parentId?.let { p -> refOf[p]?.let { o.put("parentRef", it) } }
        }

        // 워크플로 — 현재 버전 그래프만(이력 제외 — 붙여넣기 크기·이식성 우선)
        val flows = if (wsId == null) flowRepo.findByTenantIdAndArchivedFalseAndWorkspaceIdIsNullOrderByUpdatedAtDesc(tenant())
        else flowRepo.findByTenantIdAndArchivedFalseAndWorkspaceIdOrderByUpdatedAtDesc(tenant(), wsId)
        val flowArr = root.putArray("flows")
        for (fl in flows) {
            val o = flowArr.addObject()
            o.put("name", fl.name)
            fl.description?.let { o.put("description", it) }
            fl.folderId?.let { fid -> refOf[fid]?.let { o.put("folderRef", it) } }
            val graph = versionRepo.findByFlowIdAndVersionNo(fl.id, fl.currentVersion)
                .map { json.readTree(it.graphJson) }.orElse(null)
            if (graph != null) o.set<JsonNode>("graph", graph)
        }

        // Mock 서버 — spec 포함
        val mocks = mockRepo.findByTenantIdOrderByUpdatedAtDesc(tenant()).filter { it.workspaceId == wsId }
        val mockArr = root.putArray("mocks")
        for (m in mocks) {
            val o = mockArr.addObject()
            o.put("name", m.name)
            o.put("slug", m.slug)
            o.put("kind", m.kind.name)
            o.put("enabled", m.isEnabled)
            val spec = m.specJson?.takeIf { it.isNotBlank() }?.let { json.readTree(it) }
            if (spec != null) o.set<JsonNode>("spec", spec)
        }
        return root
    }

    // ── import ─────────────────────────────────────────────────────────

    data class ImportResult(
        val folders: Int, val flows: Int, val mocks: Int,
        val warnings: List<String>,
    )

    @Transactional
    fun import(workspaceIdRaw: String?, bundle: JsonNode?): ImportResult {
        val wsId = workspace.resolveId(workspaceIdRaw)
        workspace.requireWrite(workspace.currentUsername(), wsId)
        if (bundle == null || !bundle.isObject) throw BadRequestException("가져올 JSON 이 없습니다.")
        if (bundle.path("kind").asText("") != "flowlink-workspace") {
            throw BadRequestException("워크스페이스 내보내기 형식이 아닙니다 — kind 가 'flowlink-workspace' 여야 합니다(워크플로 하나는 에디터의 가져오기를 쓰세요).")
        }
        val warnings = ArrayList<String>()
        val t = tenant()

        // 1) 폴더 — ref → 새 id 매핑. 부모가 아직 없으면 뒤로 미루는 다중 패스(사이클/미해석은 루트로)
        val folderNodes = (bundle.path("folders") as? ArrayNode)?.toList() ?: emptyList()
        val idByRef = HashMap<String, UUID>()
        var remaining = folderNodes.toMutableList()
        var guard = 0
        while (remaining.isNotEmpty() && guard++ < 30) {
            val next = ArrayList<JsonNode>()
            for (fn in remaining) {
                val parentRef = fn.path("parentRef").asText(null)
                if (parentRef != null && !idByRef.containsKey(parentRef) && remaining.size > 1) { next.add(fn); continue }
                val name = fn.path("name").asText("폴더").take(255)
                val entity = Folder.create(t, name, parentRef?.let { idByRef[it] })
                entity.workspaceId = wsId
                val saved = folderRepo.saveAndFlush(entity)
                fn.path("ref").asText(null)?.let { idByRef[it] = saved.id }
            }
            if (next.size == remaining.size) { // 진전 없음(끊긴 참조) — 루트로 강제 생성
                for (fn in next) {
                    val entity = Folder.create(t, fn.path("name").asText("폴더").take(255), null)
                    entity.workspaceId = wsId
                    val saved = folderRepo.saveAndFlush(entity)
                    fn.path("ref").asText(null)?.let { idByRef[it] = saved.id }
                    warnings.add("폴더 '${fn.path("name").asText("")}' 의 상위 참조를 찾지 못해 루트로 가져왔습니다.")
                }
                remaining = ArrayList()
            } else remaining = next
        }

        // 2) 워크플로 — 그래프 검증 후 v1 로 생성
        var flowCount = 0
        for (fn in (bundle.path("flows") as? ArrayNode)?.toList() ?: emptyList()) {
            val name = fn.path("name").asText("가져온 워크플로").take(255)
            val graph = fn.path("graph")
            val graphJson = if (graph.isObject) {
                val g = (graph as ObjectNode).deepCopy()
                g.put("name", name)
                if (!g.has("nodes")) g.putArray("nodes")
                if (!g.has("edges")) g.putArray("edges")
                json.toJson(g)
            } else {
                warnings.add("워크플로 '$name' 에 그래프가 없어 빈 그래프로 가져왔습니다.")
                json.toJson(mapper.createObjectNode().apply { put("name", name); putArray("nodes"); putArray("edges") })
            }
            try {
                validator.validate(json.parseGraph(graphJson))
            } catch (e: Exception) {
                warnings.add("워크플로 '$name' 그래프 검증 실패로 건너뜀: ${e.message}")
                continue
            }
            var flow = Flow.create(t, name, fn.path("description").asText(null))
            flow.currentVersion = 1
            flow.folderId = fn.path("folderRef").asText(null)?.let { idByRef[it] }
            flow.workspaceId = wsId
            flow = flowRepo.saveAndFlush(flow)
            versionRepo.save(FlowVersion.create(flow.id, 1, name, graphJson, "워크스페이스 가져오기", null))
            flowCount++
        }

        // 3) Mock — slug 충돌은 -2,-3… 자동 개명, TCP 는 꺼서 가져옴(포트 전역 자원)
        var mockCount = 0
        for (mn in (bundle.path("mocks") as? ArrayNode)?.toList() ?: emptyList()) {
            val wantSlug = mn.path("slug").asText("").lowercase(Locale.ROOT)
            if (!Regex("[a-z0-9-]{3,40}").matches(wantSlug)) {
                warnings.add("mock slug '${mn.path("slug").asText("")}' 형식이 올바르지 않아 건너뜀.")
                continue
            }
            var slug = wantSlug
            var n = 2
            while (mockRepo.existsByTenantIdAndSlug(t, slug)) {
                slug = "$wantSlug-$n".take(40)
                n++
                if (n > 50) break
            }
            if (mockRepo.existsByTenantIdAndSlug(t, slug)) { warnings.add("mock '$wantSlug' slug 대체 실패로 건너뜀."); continue }
            if (slug != wantSlug) warnings.add("mock slug 충돌 — '$wantSlug' → '$slug' 로 개명(서빙 주소는 전역 유일).")

            val kind = try { MockServer.Kind.valueOf(mn.path("kind").asText("HTTP")) } catch (e: IllegalArgumentException) { MockServer.Kind.HTTP }
            val specNode = mn.path("spec")
            val specJson = if (specNode.isObject) specNode.toString() else null
            try { mockService.parseSpec(specJson) } catch (e: Exception) {
                warnings.add("mock '$slug' spec 파싱 실패로 건너뜀: ${e.message}")
                continue
            }
            val entity = MockServer.create(t, mn.path("name").asText(slug).take(255), slug, kind, specJson)
            entity.workspaceId = wsId
            val isTcp = kind == MockServer.Kind.TCP || (specNode.isObject && specNode.has("tcp"))
            entity.isEnabled = if (isTcp) false else mn.path("enabled").asBoolean(true)
            if (isTcp) warnings.add("TCP mock '$slug' 은 꺼진 상태로 가져옴 — 포트 충돌 확인 후 켜세요.")
            val saved = mockRepo.saveAndFlush(entity)
            try { tcpRegistry.sync(saved) } catch (e: Exception) { log.warn("가져온 mock sync 실패(무시): {}", e.message) }
            mockCount++
        }

        log.info("워크스페이스 가져오기 완료 — folders={}, flows={}, mocks={}, warnings={}", idByRef.size, flowCount, mockCount, warnings.size)
        return ImportResult(idByRef.size, flowCount, mockCount, warnings)
    }
}
