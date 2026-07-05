package com.flowlink.definition;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.flowlink.common.error.NotFoundException;
import com.flowlink.common.json.JsonService;
import com.flowlink.common.tenant.TenantContext;
import com.flowlink.core.domain.Flow;
import com.flowlink.core.domain.FlowVersion;
import com.flowlink.core.graph.FlowGraph;
import com.flowlink.core.graph.GraphValidator;
import com.flowlink.core.repository.FlowRepository;
import com.flowlink.core.repository.FlowVersionRepository;
import com.flowlink.definition.dto.CreateFlowRequest;
import com.flowlink.definition.dto.FlowDetail;
import com.flowlink.definition.dto.FlowSummary;
import com.flowlink.definition.dto.FlowVersionSummary;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/** 워크플로 정의(메타데이터 + 불변 버전) 관리. */
@Service
public class FlowService {

    private final FlowRepository flowRepo;
    private final FlowVersionRepository versionRepo;
    private final JsonService json;
    private final GraphValidator validator;
    private final ObjectMapper mapper;

    public FlowService(FlowRepository flowRepo, FlowVersionRepository versionRepo,
                       JsonService json, GraphValidator validator) {
        this.flowRepo = flowRepo;
        this.versionRepo = versionRepo;
        this.json = json;
        this.validator = validator;
        this.mapper = json.mapper();
    }

    @Transactional(readOnly = true)
    public List<FlowSummary> list() {
        return flowRepo.findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(tenant())
                .stream().map(FlowSummary::from).toList();
    }

    @Transactional(readOnly = true)
    public FlowDetail get(UUID id) {
        return toDetail(loadFlow(id));
    }

    @Transactional
    public FlowDetail create(CreateFlowRequest req) {
        Flow flow = createInternal(req.name(), req.description(), emptyGraph(req.name()), "초기 버전", req.folderId());
        return toDetail(flow);
    }

    @Transactional
    public void moveToFolder(UUID id, UUID folderId) {
        loadFlow(id).setFolderId(folderId);
    }

    @Transactional
    public void archive(UUID id) {
        loadFlow(id).setArchived(true);
    }

    @Transactional
    public FlowVersionSummary saveVersion(UUID id, JsonNode graph, String note) {
        Flow flow = loadFlow(id);
        String graphJson = json.toJson(graph);
        FlowGraph parsed = json.parseGraph(graphJson);
        validator.validate(parsed);

        String name = (parsed.name() != null && !parsed.name().isBlank()) ? parsed.name() : flow.getName();
        int nextNo = flow.getCurrentVersion() + 1;

        FlowVersion version = FlowVersion.create(flow.getId(), nextNo, name, graphJson, note, null);
        versionRepo.save(version);

        flow.setName(name);
        flow.setCurrentVersion(nextNo);
        return FlowVersionSummary.from(version);
    }

    @Transactional
    public FlowDetail importFlow(JsonNode export) {
        String name = textOr(export, "name", "가져온 플로우");
        ObjectNode graph = mapper.createObjectNode();
        graph.put("name", name);
        graph.set("nodes", export.has("nodes") ? export.get("nodes") : mapper.createArrayNode());
        graph.set("edges", export.has("edges") ? export.get("edges") : mapper.createArrayNode());

        // 가져온 그래프를 검증한 뒤 v1 으로 적재
        FlowGraph parsed = json.parseGraph(json.toJson(graph));
        validator.validate(parsed);

        Flow flow = createInternal(name, textOr(export, "desc", ""), json.toJson(graph), "가져오기", null);
        return toDetail(flow);
    }

    // --- 내부 ---

    private Flow createInternal(String name, String description, String initialGraphJson, String note, UUID folderId) {
        Flow flow = Flow.create(tenant(), name, description);
        // 할당식 UUID 엔티티는 save()가 merge로 동작하므로, save 이후의 변경이 누락되지 않도록
        // currentVersion 을 저장 전에 확정한다(항상 v1 을 함께 생성). saveAndFlush 로 INSERT 를 즉시
        // 반영해 @CreationTimestamp/@UpdateTimestamp 가 채워진 관리 인스턴스를 반환한다.
        flow.setCurrentVersion(1);
        flow.setFolderId(folderId);
        flow = flowRepo.saveAndFlush(flow);
        FlowVersion v1 = FlowVersion.create(flow.getId(), 1, name, initialGraphJson, note, null);
        versionRepo.save(v1);
        return flow;
    }

    private Flow loadFlow(UUID id) {
        return flowRepo.findByIdAndTenantId(id, tenant())
                .orElseThrow(() -> NotFoundException.of("Flow", id));
    }

    private JsonNode currentGraph(Flow flow) {
        if (flow.getCurrentVersion() <= 0) {
            return json.readTree(emptyGraph(flow.getName()));
        }
        return versionRepo.findByFlowIdAndVersionNo(flow.getId(), flow.getCurrentVersion())
                .map(v -> json.readTree(v.getGraphJson()))
                .orElseGet(() -> json.readTree(emptyGraph(flow.getName())));
    }

    private FlowDetail toDetail(Flow flow) {
        return new FlowDetail(flow.getId(), flow.getName(), flow.getDescription(),
                flow.getCurrentVersion(), flow.getCreatedAt(), flow.getUpdatedAt(), currentGraph(flow));
    }

    private String emptyGraph(String name) {
        ObjectNode g = mapper.createObjectNode();
        g.put("name", name);
        g.set("nodes", mapper.createArrayNode());
        g.set("edges", mapper.createArrayNode());
        return json.toJson(g);
    }

    private static String textOr(JsonNode node, String field, String fallback) {
        JsonNode v = node.get(field);
        return (v != null && v.isTextual() && !v.asText().isBlank()) ? v.asText() : fallback;
    }

    private static String tenant() {
        return TenantContext.getTenantId();
    }
}
