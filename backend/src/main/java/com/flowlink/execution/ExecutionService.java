package com.flowlink.execution;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.flowlink.common.error.BadRequestException;
import com.flowlink.common.error.NotFoundException;
import com.flowlink.common.json.JsonService;
import com.flowlink.common.tenant.TenantContext;
import com.flowlink.core.domain.Execution;
import com.flowlink.core.domain.Flow;
import com.flowlink.core.domain.FlowVersion;
import com.flowlink.core.domain.NodeExecution;
import com.flowlink.core.domain.TriggerType;
import com.flowlink.core.graph.FlowGraph;
import com.flowlink.core.graph.NodeType;
import com.flowlink.core.repository.ExecutionRepository;
import com.flowlink.core.repository.FlowRepository;
import com.flowlink.core.repository.FlowVersionRepository;
import com.flowlink.core.repository.NodeExecutionRepository;
import com.flowlink.execution.config.ExecutionProperties;
import com.flowlink.execution.dto.ExecutionDetail;
import com.flowlink.execution.dto.ExecutionSummary;
import com.flowlink.execution.dto.NodeExecutionView;
import com.flowlink.execution.dto.RunRequest;
import com.flowlink.execution.engine.ExecutionContext;
import com.flowlink.execution.engine.FlowExecutor;
import com.flowlink.execution.engine.NodeRecorder;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 워크플로 실행의 진입점 + 영속화 경계.
 *
 * <p>주의(Phase 1): 동기 실행이다 — 호출 스레드가 모든 노드(외부 HTTP 포함)를 끝까지 수행한다.
 * 운영용 비동기 큐/워커(at-least-once)·내구성 실행은 후속 Phase. DB 트랜잭션을 외부 호출 동안
 * 길게 잡지 않도록, 노드별 결과는 짧은 독립 트랜잭션으로 즉시 저장한다(run() 은 비트랜잭션).
 */
@Service
public class ExecutionService {

    private final FlowRepository flowRepo;
    private final FlowVersionRepository versionRepo;
    private final ExecutionRepository executionRepo;
    private final NodeExecutionRepository nodeExecRepo;
    private final FlowExecutor flowExecutor;
    private final JsonService json;
    private final ObjectMapper mapper;
    private final ExecutionProperties props;

    public ExecutionService(FlowRepository flowRepo, FlowVersionRepository versionRepo,
                            ExecutionRepository executionRepo, NodeExecutionRepository nodeExecRepo,
                            FlowExecutor flowExecutor, JsonService json, ExecutionProperties props) {
        this.flowRepo = flowRepo;
        this.versionRepo = versionRepo;
        this.executionRepo = executionRepo;
        this.nodeExecRepo = nodeExecRepo;
        this.flowExecutor = flowExecutor;
        this.json = json;
        this.mapper = json.mapper();
        this.props = props;
    }

    public ExecutionDetail run(UUID flowId, RunRequest req) {
        String tenant = TenantContext.getTenantId();
        Flow flow = flowRepo.findByIdAndTenantId(flowId, tenant)
                .orElseThrow(() -> NotFoundException.of("Flow", flowId));

        int versionNo = (req != null && req.versionNo() != null) ? req.versionNo() : flow.getCurrentVersion();
        FlowVersion version = versionRepo.findByFlowIdAndVersionNo(flowId, versionNo)
                .orElseThrow(() -> NotFoundException.of("FlowVersion", flowId + "/v" + versionNo));

        FlowGraph graph = json.parseGraph(version.getGraphJson());
        if (graph.nodesOrEmpty().size() > props.maxNodesPerRun()) {
            throw new BadRequestException("노드 수가 상한을 초과했습니다.");
        }

        String inputJson = (req != null && req.input() != null && !req.input().isNull())
                ? json.toJson(req.input()) : null;

        Execution execution = Execution.start(tenant, flowId, version.getId(),
                TriggerType.MANUAL, currentUser(), inputJson);
        executionRepo.save(execution);
        UUID execId = execution.getId();

        ExecutionContext ctx = new ExecutionContext();
        seedInput(ctx, req);

        boolean captureBodies = props.capture().requestResponseBodies();
        NodeRecorder recorder = (node, seq, result, status, durationMs) -> {
            NodeExecution ne = NodeExecution.of(execId, node.id(), node.name(), node.type(), seq);
            String outputJson = result.storedValue() != null ? json.toJson(result.storedValue()) : null;
            // redaction deny-by-default: HTTP 노드의 요청/응답 본문(URL·헤더·바디엔 토큰·시크릿이 섞일 수 있음)은
            // 캡처가 명시적으로 켜진 경우에만 저장. 제어 노드(start/if/set 등)의 무해한 표시는 그대로 둔다.
            boolean redact = !captureBodies && node.nodeType() == NodeType.HTTP;
            String requestText = redact ? "(redacted — capture 비활성)" : result.requestText();
            String responseText = redact ? "(redacted — capture 비활성)" : result.responseText();
            ne.complete(status, result.ok(), result.httpStatus(),
                    requestText, responseText, outputJson, durationMs);
            nodeExecRepo.save(ne);
        };

        try {
            FlowExecutor.Outcome outcome = flowExecutor.execute(graph, ctx, recorder);
            switch (outcome.status()) {
                case SUCCEEDED -> execution.markSucceeded();
                case WAITING -> execution.markWaiting();
                case FAILED -> execution.markFailed(outcome.error());
                default -> execution.markFailed("알 수 없는 실행 결과");
            }
        } catch (Exception e) {
            execution.markFailed("실행 중 오류: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
        executionRepo.save(execution);
        return detail(execution);
    }

    @Transactional(readOnly = true)
    public ExecutionDetail get(UUID executionId) {
        Execution e = executionRepo.findByIdAndTenantId(executionId, TenantContext.getTenantId())
                .orElseThrow(() -> NotFoundException.of("Execution", executionId));
        return detail(e);
    }

    @Transactional(readOnly = true)
    public List<ExecutionSummary> listForFlow(UUID flowId, int limit) {
        return executionRepo.findByFlowIdOrderByStartedAtDesc(flowId, PageRequest.of(0, clamp(limit)))
                .stream().map(ExecutionSummary::from).toList();
    }

    @Transactional(readOnly = true)
    public List<ExecutionSummary> listRecent(int limit) {
        return executionRepo.findByTenantIdOrderByStartedAtDesc(TenantContext.getTenantId(), PageRequest.of(0, clamp(limit)))
                .stream().map(ExecutionSummary::from).toList();
    }

    // --- 내부 ---

    private void seedInput(ExecutionContext ctx, RunRequest req) {
        if (req == null || req.input() == null || !req.input().isObject()) {
            return;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> inputMap = mapper.convertValue(req.input(), Map.class);
        ctx.putOutput("input", inputMap);
    }

    private ExecutionDetail detail(Execution e) {
        List<NodeExecutionView> nodes = nodeExecRepo.findByExecutionIdOrderBySeqAsc(e.getId())
                .stream().map(this::toView).toList();
        return new ExecutionDetail(e.getId(), e.getFlowId(), e.getFlowVersionId(), e.getStatus(),
                e.getTrigger(), e.getTriggeredBy(), e.getStartedAt(), e.getFinishedAt(), e.getError(), nodes);
    }

    private NodeExecutionView toView(NodeExecution n) {
        JsonNode output = n.getOutputJson() == null ? null : json.readTree(n.getOutputJson());
        return new NodeExecutionView(n.getId(), n.getNodeId(), n.getNodeName(), n.getNodeType(),
                n.getSeq(), n.getStatus(), n.getHttpStatus(), n.getDurationMs(), n.isOk(),
                n.getRequestText(), n.getResponseText(), output);
    }

    private static int clamp(int limit) {
        if (limit <= 0) {
            return 50;
        }
        return Math.min(limit, 200);
    }

    private static String currentUser() {
        // 인증 도입 전: null. 후속 Phase에서 SecurityContext(OIDC subject)로 채운다.
        return null;
    }
}
