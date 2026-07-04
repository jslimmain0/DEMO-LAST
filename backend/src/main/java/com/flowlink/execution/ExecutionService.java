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
import com.flowlink.core.graph.GraphNode;
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
import com.flowlink.execution.dto.PendingFormRequest;
import com.flowlink.execution.dto.PendingInputRequest;
import com.flowlink.execution.dto.PendingWaitRequest;
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
import java.util.regex.Pattern;

/**
 * 워크플로 실행의 진입점 + 영속화 경계.
 *
 * <p>주의(Phase 1): 동기 실행이다 — 호출 스레드가 모든 노드(외부 HTTP 포함)를 끝까지 수행한다.
 * 운영용 비동기 큐/워커(at-least-once)·내구성 실행은 후속 Phase. DB 트랜잭션을 외부 호출 동안
 * 길게 잡지 않도록, 노드별 결과는 짧은 독립 트랜잭션으로 즉시 저장한다(run() 은 비트랜잭션).
 */
@Service
public class ExecutionService {

    /** 브라우저가 만든 relay 실행ID — 영숫자 8~64자만 인정(수신 URL 경로에 들어간다). */
    private static final Pattern RELAY_RUN_ID = Pattern.compile("^[A-Za-z0-9]{8,64}$");

    private final FlowRepository flowRepo;
    private final FlowVersionRepository versionRepo;
    private final ExecutionRepository executionRepo;
    private final NodeExecutionRepository nodeExecRepo;
    private final FlowExecutor flowExecutor;
    private final JsonService json;
    private final ObjectMapper mapper;
    private final ExecutionProperties props;

    /**
     * 브라우저 협업 노드(client HTTP / form / wait)에서 WAITING 으로 중단된 실행의 재개 상태(인메모리).
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

        // wait(콜백 대기) 노드 수신 URL 시드 — 실행 시작 시점에 모든 wait 노드의 url 출력을 미리 확정해
        // {{ url@노드ID }} 가 wait 보다 앞의 노드(returnUrl/notiUrl)에서도 해석되게 한다.
        // putSeed: 명시 스코프/바인딩에만 보임 — bare {{ url }} 의 nearest-upstream 해석을 오염시키지 않는다.
        String relayRunId = sanitizeRelayRunId(req == null ? null : req.relayRunId());
        String relayBase = sanitizeRelayBase(req == null ? null : req.relayBase());
        if (relayRunId != null && relayBase != null) {
            for (GraphNode n : graph.nodesOrEmpty()) {
                if (n.effectiveType() == NodeType.WAIT) {
                    ctx.putSeed(n.id(), Map.of("url", FlowExecutor.receiveUrl(relayBase, relayRunId, n.id())));
                }
            }
        }

        FlowExecutor.RunState state = flowExecutor.newRun(graph, ctx, relayBase, relayRunId);

        FlowExecutor.Outcome outcome;
        try {
            outcome = flowExecutor.execute(state, recorder(execId));
        } catch (Exception e) {
            execution.markFailed("실행 중 오류: " + msg(e));
            executionRepo.save(execution);
            return detail(execution, null, null, null, null);
        }
        applyStatus(execution, outcome);
        rememberIfPending(execId, outcome, state, tenant);
        executionRepo.save(execution);
        return detail(execution, outcome.pendingClient(), outcome.pendingForm(), outcome.pendingWait(), outcome.pendingInput());
    }

    /**
     * 중단된 실행(client HTTP / form / wait)을, 브라우저가 돌려준 입력으로 이어서 실행한다.
     * 또 다른 중단 지점을 만나면 다시 WAITING + pending 을 돌려준다(루프).
     */
    public ExecutionDetail resume(UUID executionId, ResumeRequest req) {
        String tenant = TenantContext.getTenantId();
        Suspended suspended = suspensions.get(executionId);
        if (suspended == null || !suspended.tenant().equals(tenant)) {
            // 멱등: 이미 재개/완료됐거나 대기 상태가 아니면 에러 대신 현재 상태를 반환.
            Execution existing = executionRepo.findByIdAndTenantId(executionId, tenant)
                    .orElseThrow(() -> NotFoundException.of("Execution", executionId));
            return detail(existing, null, null, null, null);
        }
        return doResume(executionId, suspended, req);
    }

    /** 재개 실행 + 상태반영 + 영속화 공통 경로. */
    private ExecutionDetail doResume(UUID executionId, Suspended suspended, ResumeRequest req) {
        Execution execution = executionRepo.findByIdAndTenantId(executionId, TenantContext.getTenantId())
                .orElseThrow(() -> NotFoundException.of("Execution", executionId));
        FlowExecutor.Outcome outcome;
        try {
            outcome = flowExecutor.resume(suspended.state(), toResumeInput(req),
                    req != null && req.durationMs() != null ? req.durationMs() : 0L,
                    recorder(executionId));
        } catch (Exception e) {
            suspensions.remove(executionId); // 예외 경로에서도 보관소 정리(누수 방지)
            execution.markFailed("재개 중 오류: " + msg(e));
            executionRepo.save(execution);
            return detail(execution, null, null, null, null);
        }
        // 사용자 중단(⏹)은 실패가 아니라 취소로 마감한다.
        if (req != null && Boolean.TRUE.equals(req.aborted()) && outcome.status() == ExecutionStatus.FAILED) {
            execution.markCancelled(outcome.error());
        } else {
            applyStatus(execution, outcome);
        }
        rememberIfPending(executionId, outcome, suspended.state(), suspended.tenant());
        executionRepo.save(execution);
        return detail(execution, outcome.pendingClient(), outcome.pendingForm(), outcome.pendingWait(), outcome.pendingInput());
    }

    private static FlowExecutor.ResumeInput toResumeInput(ResumeRequest req) {
        if (req == null) {
            return new FlowExecutor.ResumeInput(null, null, null, null, null, null);
        }
        FlowExecutor.ResumeInput.Callback cb = req.callback() == null ? null
                : new FlowExecutor.ResumeInput.Callback(req.callback().method(), req.callback().url(),
                        req.callback().headers(), req.callback().body());
        return new FlowExecutor.ResumeInput(req.status(), req.body(), req.error(),
                req.popupOpened(), cb, req.formValues());
    }

    private static String sanitizeRelayRunId(String raw) {
        if (raw == null || !RELAY_RUN_ID.matcher(raw).matches()) {
            return null;
        }
        return raw;
    }

    private static String sanitizeRelayBase(String raw) {
        if (raw == null || raw.isBlank() || raw.length() > 200) {
            return null;
        }
        String base = raw.trim();
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            return null;
        }
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base;
    }

    @Transactional(readOnly = true)
    public ExecutionDetail get(UUID executionId) {
        Execution e = executionRepo.findByIdAndTenantId(executionId, TenantContext.getTenantId())
                .orElseThrow(() -> NotFoundException.of("Execution", executionId));
        return detail(e, null, null, null, null);
    }

    @Transactional(readOnly = true)
    public List<ExecutionSummary> listForFlow(UUID flowId, int limit) {
        var execs = executionRepo.findByFlowIdOrderByStartedAtDesc(flowId, PageRequest.of(0, clamp(limit)));
        return withFlowNames(execs);
    }

    @Transactional(readOnly = true)
    public List<ExecutionSummary> listRecent(int limit) {
        var execs = executionRepo.findByTenantIdOrderByStartedAtDesc(TenantContext.getTenantId(), PageRequest.of(0, clamp(limit)));
        return withFlowNames(execs);
    }

    /** 실행 목록에 워크플로 이름을 채운다(삭제/보관된 플로우도 이름 조회 — UUID 노출 방지). */
    private List<ExecutionSummary> withFlowNames(List<com.flowlink.core.domain.Execution> execs) {
        var ids = execs.stream().map(com.flowlink.core.domain.Execution::getFlowId).collect(java.util.stream.Collectors.toSet());
        var names = new java.util.HashMap<UUID, String>();
        flowRepo.findAllById(ids).forEach(f -> names.put(f.getId(), f.getName()));
        return execs.stream().map(e -> ExecutionSummary.from(e, names.get(e.getFlowId()))).toList();
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

    /** 중단(pending)되면 재개 상태를 보관하고, 그 외(완료/실패)면 비운다. */
    private void rememberIfPending(UUID execId, FlowExecutor.Outcome outcome,
                                   FlowExecutor.RunState state, String tenant) {
        if (outcome.status() == ExecutionStatus.WAITING && outcome.isPending()) {
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

    private ExecutionDetail detail(Execution e, FlowExecutor.PendingClient pending,
                                   FlowExecutor.PendingForm form, FlowExecutor.PendingWait wait,
                                   FlowExecutor.PendingInput input) {
        List<NodeExecutionView> nodes = nodeExecRepo.findByExecutionIdOrderBySeqAsc(e.getId())
                .stream().map(this::toView).toList();
        PendingClientRequest pc = pending == null ? null : new PendingClientRequest(
                pending.nodeId(), pending.nodeName(), pending.method(), pending.url(),
                pending.headers(), pending.body(), pending.respType());
        PendingFormRequest pf = form == null ? null : new PendingFormRequest(
                form.nodeId(), form.nodeName(), form.action(), form.method(),
                (form.fields() == null ? List.<FlowExecutor.PendingForm.Field>of() : form.fields()).stream()
                        .map(f -> new PendingFormRequest.FormField(f.key(), f.value())).toList());
        PendingWaitRequest pw = wait == null ? null : new PendingWaitRequest(
                wait.nodeId(), wait.nodeName(), wait.timeoutSec(), wait.receiveUrl());
        PendingInputRequest pi = input == null ? null : new PendingInputRequest(
                input.nodeId(), input.nodeName(), input.message(),
                (input.fields() == null ? List.<FlowExecutor.PendingInput.Field>of() : input.fields()).stream()
                        .map(f -> new PendingInputRequest.InputField(f.key(), f.label(), f.type())).toList());
        return new ExecutionDetail(e.getId(), e.getFlowId(), e.getFlowVersionId(), e.getStatus(),
                e.getTrigger(), e.getTriggeredBy(), e.getStartedAt(), e.getFinishedAt(), e.getError(),
                nodes, pc, pf, pw, pi);
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
