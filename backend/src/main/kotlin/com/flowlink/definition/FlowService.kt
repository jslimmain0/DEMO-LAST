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
    private val json: JsonService,
    private val validator: GraphValidator
) {
    private val mapper: ObjectMapper = json.mapper()

    @Transactional(readOnly = true)
    fun list(): List<FlowSummary> =
        flowRepo.findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(tenant())
            .map { summaryOf(it) }

    // 목록 카드 미리보기 + 내용 검색을 위해 현재 버전 그래프에서 노드 요약을 뽑는다(서버측 1왕복 — 카드별 재조회 N+1 제거).
    private fun summaryOf(flow: Flow): FlowSummary {
        val types = ArrayList<String>()
        val cats = ArrayList<String>()
        val text = StringBuilder()
        var count = 0
        try {
            val nodes = currentGraph(flow).get("nodes")
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
        val blob = text.toString().trim().lowercase().take(700)
        return FlowSummary(
            flow.id, flow.name, flow.description, flow.currentVersion, flow.folderId, flow.updatedAt,
            count, types, cats, blob.ifBlank { null }
        )
    }

    @Transactional(readOnly = true)
    fun get(id: UUID): FlowDetail = toDetail(loadFlow(id))

    @Transactional
    fun create(req: CreateFlowRequest): FlowDetail {
        val flow = createInternal(req.name, req.description, emptyGraph(req.name), "초기 버전", req.folderId)
        log.info("워크플로 생성: id={} name='{}' folder={} by={}", flow.id, flow.name, req.folderId, currentUser() ?: "-")
        return toDetail(flow)
    }

    @Transactional
    fun moveToFolder(id: UUID, folderId: UUID?) {
        loadFlow(id).folderId = folderId
        log.info("워크플로 폴더 이동: id={} → folder={}", id, folderId ?: "(미분류)")
    }

    @Transactional
    fun updateMeta(id: UUID, name: String?, description: String?): FlowDetail {
        val flow = loadFlow(id)
        name?.takeIf { it.isNotBlank() }?.let { flow.name = it }
        if (description != null) flow.description = description
        log.info("워크플로 정보 변경: id={} name='{}'", id, flow.name)
        return toDetail(flow)
    }

    @Transactional
    fun archive(id: UUID) {
        val flow = loadFlow(id)
        flow.archived = true
        log.info("워크플로 보관(삭제): id={} name='{}' by={}", id, flow.name, currentUser() ?: "-")
    }

    @Transactional
    fun saveVersion(id: UUID, graph: JsonNode, note: String?): FlowVersionSummary {
        val flow = loadFlow(id)
        val graphJson = json.toJson(graph)
        val parsed = json.parseGraph(graphJson)
        validator.validate(parsed)

        val gname = parsed.name
        val name = if (gname != null && gname.isNotBlank()) gname else flow.name
        val nextNo = flow.currentVersion + 1

        val version = FlowVersion.create(flow.id, nextNo, name, graphJson, note, currentUser())
        // 할당식 UUID 엔티티는 save 가 merge 로 동작 → @CreationTimestamp lateinit createdAt 은
        // **반환된 관리 인스턴스**에만 채워진다(원본 version 은 merge 소스라 미초기화). from 이 createdAt
        // 을 읽으므로 반환값(saved)을 써야 한다. createInternal 의 `flow = saveAndFlush(flow)` 와 동일 이유.
        val saved = versionRepo.saveAndFlush(version)

        flow.name = name
        flow.currentVersion = nextNo
        log.info("워크플로 저장: id={} name='{}' v{} 노드 {}개 · 연결 {}개 by={}{}",
            id, name, nextNo, parsed.nodesOrEmpty().size, parsed.edgesOrEmpty().size,
            currentUser() ?: "-", if (note.isNullOrBlank()) "" else " note='$note'")
        return FlowVersionSummary.from(saved)
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
        val flow = loadFlow(id)
        val src = versionRepo.findByFlowIdAndVersionNo(id, versionNo)
            .orElseThrow { NotFoundException.of("FlowVersion", versionNo) }
        val nextNo = flow.currentVersion + 1
        val note = "v$versionNo 복원"
        val restored = FlowVersion.create(flow.id, nextNo, src.name, src.graphJson, note, currentUser())
        val saved = versionRepo.saveAndFlush(restored)
        flow.name = src.name
        flow.currentVersion = nextNo
        log.info("워크플로 버전 복원: id={} v{} → 새 v{} by={}", id, versionNo, nextNo, currentUser() ?: "-")
        return FlowVersionSummary.from(saved)
    }

    @Transactional
    fun importFlow(export: JsonNode): FlowDetail {
        val name = textOr(export, "name", "가져온 플로우")
        val graph: ObjectNode = mapper.createObjectNode()
        graph.put("name", name)
        graph.set<JsonNode>("nodes", if (export.has("nodes")) export.get("nodes") else mapper.createArrayNode())
        graph.set<JsonNode>("edges", if (export.has("edges")) export.get("edges") else mapper.createArrayNode())

        // 가져온 그래프를 검증한 뒤 v1 으로 적재
        val parsed = json.parseGraph(json.toJson(graph))
        validator.validate(parsed)

        val flow = createInternal(name, textOr(export, "desc", ""), json.toJson(graph), "가져오기", null)
        log.info("워크플로 가져오기: id={} name='{}' 노드 {}개", flow.id, name, parsed.nodesOrEmpty().size)
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
        flowRepo.findByIdAndTenantId(id, tenant())
            .orElseThrow { NotFoundException.of("Flow", id) }

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
            flow.currentVersion, flow.folderId, flow.createdAt, flow.updatedAt, currentGraph(flow)
        )

    private fun emptyGraph(name: String): String {
        val g: ObjectNode = mapper.createObjectNode()
        g.put("name", name)
        g.set<JsonNode>("nodes", mapper.createArrayNode())
        g.set<JsonNode>("edges", mapper.createArrayNode())
        return json.toJson(g)
    }

    companion object {
        private val log = org.slf4j.LoggerFactory.getLogger(FlowService::class.java)

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
