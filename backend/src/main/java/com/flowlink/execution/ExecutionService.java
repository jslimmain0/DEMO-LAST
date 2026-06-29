package com.flowlink.execution;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.flowlink.common.error.BadRequestException;
import com.flowlink.common.error.NotFoundException;
import com.flowlink.common.json.JsonService;
import com.flowlink.common.tenant.TenantContext;
import com.flowlink.core.domain.Execution;
import com.flowlink.core.domain.ExecutionStatus;
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
import com.flowlink.execution.dto.PendingClientRequest;
import com.flowlink.execution.dto.ResumeRequest;
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
import java.util.concurrent.ConcurrentHashMap;

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

    /**
     * client 모드 HTTP 노드에서 WAITING 으로 중단된 실행의 재개 상태(인메모리).
     * 단일 인스턴스/세션 한정 — 서버 재시작 시 소실되며 내구성 보관은 후속 Phase.
     */
    private final Map<UUID, Suspended> suspensions = new ConcurrentHashMap<>();

    private record Suspended(FlowExecutor.RunState state, String tenant) {
    }

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
        FlowExecutor.RunState state = flowExecutor.newRun(graph, ctx);

        FlowExecutor.Outcome outcome;
        try {
            outcome = flowExecutor.execute(state, recorder(execId));
        } catch (Exception e) {
            execution.markFailed("실행 중 오류: " + msg(e));
            executionRepo.save(execution);
            return detail(execution, null);
        }
        applyStatus(execution, outcome);
        rememberIfPending(execId, outcome, state, tenant);
        executionRepo.save(execution);
        return detail(execution, outcome.pending());
    }

    /**
     * client(클라이언트→서버) 모드 노드에서 중단된 실행을, 브라우저가 호출한 결과로 이어서 실행한다.
     * 또 다른 client 노드를 만나면 다시 WAITING + pending 을 돌려준다(루프).
     */
    public ExecutionDetail resume(UUID executionId, ResumeRequest req) {
        String tenant = TenantContext.getTenantId();
        Execution execution = executionRepo.findByIdAndTenantId(executionId, tenant)
                .orElseThrow(() -> NotFoundException.of("Execution", executionId));
        Suspended suspended = suspensions.get(executionId);
        if (suspended == null || !suspended.tenant().equals(tenant)) {
            throw new BadRequestException("재개할 수 없는 실행입니다(만료되었거나 대기 상태가 아닙니다).");
        }

        FlowExecutor.Outcome outcome;
        try {
            outcome = flowExecutor.resume(suspended.state(),
                    req == null ? null : req.nodeId(),
                    req != null && req.status() != null ? req.status() : 0,
                    req == null ? null : req.body(),
                    req == null ? null : req.error(),
                    req != null && req.durationMs() != null ? req.durationMs() : 0L,
                    recorder(executionId));
        } catch (Exception e) {
            suspensions.remove(executionId);
            execution.markFailed("재개 중 오류: " + msg(e));
            executionRepo.save(execution);
            return detail(execution, null);
        }
        applyStatus(execution, outcome);
        rememberIfPending(executionId, outcome, suspended.state(), tenant);
        executionRepo.save(execution);
        return detail(execution, outcome.pending());
    }

    @Transactional(readOnly = true)
    public ExecutionDetail get(UUID executionId) {
        Execution e = executionRepo.findByIdAndTenantId(executionId, TenantContext.getTenantId())
                .orElseThrow(() -> NotFoundException.of("Execution", executionId));
        return detail(e, null);
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

    /**
     * 노드별 결과를 짧은 독립 트랜잭션으로 즉시 저장하는 콜백. run()/resume() 이 공유한다.
     * redaction deny-by-default: HTTP 노드의 요청/응답 본문(토큰·시크릿 섞일 수 있음)은
     * capture 가 켜진 경우에만 저장하고, 제어 노드(start/if/set 등)의 무해한 표시는 그대로 둔다.
     */
    private NodeRecorder recorder(UUID execId) {
        boolean captureBodies = props.capture().requestResponseBodies();
        return (node, seq, result, status, durationMs) -> {
            NodeExecution ne = NodeExecution.of(execId, node.id(), node.name(), node.type(), seq);
            String outputJson = result.storedValue() != null ? json.toJson(result.storedValue()) : null;
            boolean redact = !captureBodies && node.nodeType() == NodeType.HTTP;
            String requestText = redact ? "(redacted — capture 비활성)" : result.requestText();
            String responseText = redact ? "(redacted — capture 비활성)" : result.responseText();
            ne.complete(status, result.ok(), result.httpStatus(),
                    requestText, responseText, outputJson, durationMs);
            nodeExecRepo.save(ne);
        };
    }

    private void applyStatus(Execution execution, FlowExecutor.Outcome outcome) {
        switch (outcome.status()) {
            case SUCCEEDED -> execution.markSucceeded();
            case WAITING -> execution.markWaiting();
            case FAILED -> execution.markFailed(outcome.error());
            default -> execution.markFailed("알 수 없는 실행 결과");
        }
    }

    /** client 노드에서 중단(pending)되면 재개 상태를 보관하고, 그 외(완료/실패/WAIT)면 비운다. */
    private void rememberIfPending(UUID execId, FlowExecutor.Outcome outcome,
                                   FlowExecutor.RunState state, String tenant) {
        if (outcome.status() == ExecutionStatus.WAITING && outcome.pending() != null) {
            suspensions.put(execId, new Suspended(state, tenant));
        } else {
            suspensions.remove(execId);
        }
    }

    private static String msg(Exception e) {
        return e.getMessage() == null ? e.toString() : e.getMessage();
    }

    private void seedInput(ExecutionContext ctx, RunRequest req) {
        if (req == null || req.input() == null || !req.input().isObject()) {
            return;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> inputMap = mapper.convertValue(req.input(), Map.class);
        ctx.putOutput("input", inputMap);
    }

    private ExecutionDetail detail(Execution e, FlowExecutor.PendingClient pending) {
        List<NodeExecutionView> nodes = nodeExecRepo.findByExecutionIdOrderBySeqAsc(e.getId())
                .stream().map(this::toView).toList();
        PendingClientRequest pc = pending == null ? null : new PendingClientRequest(
                pending.nodeId(), pending.nodeName(), pending.method(), pending.url(),
                pending.headers(), pending.body(), pending.respType());
        return new ExecutionDetail(e.getId(), e.getFlowId(), e.getFlowVersionId(), e.getStatus(),
                e.getTrigger(), e.getTriggeredBy(), e.getStartedAt(), e.getFinishedAt(), e.getError(), nodes, pc);
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
