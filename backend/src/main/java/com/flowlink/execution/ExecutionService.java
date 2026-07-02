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
import com.flowlink.execution.dto.PendingFormRequest;
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
     * client 모드 HTTP 노드/폼 전송(WAIT) 노드에서 WAITING 으로 중단된 실행의 재개 상태(인메모리).
     * 단일 인스턴스/세션 한정 — 서버 재시작 시 소실되며 내구성 보관은 후속 Phase.
     */
    private final Map<UUID, Suspended> suspensions = new ConcurrentHashMap<>();

    /**
     * 게이트웨이 콜백 토큰 → 실행 id 역방향 인덱스. 폼 전송 노드가 {@code {{ __callbackUrl }}} 을 쓸 때만 채워지며,
     * 인증 없는(permitAll) 콜백 엔드포인트가 추측 불가능한 UUID 토큰으로 실행/테넌트를 되찾는다.
     */
    private final Map<String, UUID> callbackTokens = new ConcurrentHashMap<>();

    /**
     * 상관키(corrId) → 실행 id 역방향 인덱스. 고정(사전등록) 콜백 URL 은 실행마다 안 바뀌므로,
     * 게이트웨이가 echo 하는 corrId 값으로 대기 중인 실행을 찾는다({@code {{ __corrId }}} 사용 시에만 채워짐).
     */
    private final Map<String, UUID> corrIds = new ConcurrentHashMap<>();

    private record Suspended(FlowExecutor.RunState state, String tenant, String callbackToken, String corrId) {
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
            return detail(execution, null, null);
        }
        applyStatus(execution, outcome);
        rememberIfPending(execId, outcome, state, tenant);
        executionRepo.save(execution);
        return detail(execution, outcome.pendingClient(), outcome.pendingForm());
    }

    /**
     * 중단된 실행(client HTTP 또는 WAIT 폼)을, 브라우저가 돌려준 입력으로 이어서 실행한다.
     * 또 다른 중단 지점을 만나면 다시 WAITING + pending 을 돌려준다(루프).
     */
    public ExecutionDetail resume(UUID executionId, ResumeRequest req) {
        String tenant = TenantContext.getTenantId();
        Suspended suspended = suspensions.get(executionId);
        if (suspended == null || !suspended.tenant().equals(tenant)) {
            // 멱등: 이미 재개/완료됐거나(예: 서버 노티가 먼저 처리) 대기 상태가 아니면 에러 대신 현재 상태를 반환.
            Execution existing = executionRepo.findByIdAndTenantId(executionId, tenant)
                    .orElseThrow(() -> NotFoundException.of("Execution", executionId));
            return detail(existing, null, null);
        }
        return doResume(executionId, suspended, req);
    }

    /** 재개 실행 + 상태반영 + 영속화 공통 경로. 브라우저 resume 과 서버 노티(고정 콜백) 재개가 공유한다. */
    private ExecutionDetail doResume(UUID executionId, Suspended suspended, ResumeRequest req) {
        Execution execution = executionRepo.findByIdAndTenantId(executionId, TenantContext.getTenantId())
                .orElseThrow(() -> NotFoundException.of("Execution", executionId));
        FlowExecutor.Outcome outcome;
        try {
            outcome = flowExecutor.resume(suspended.state(),
                    req == null ? null : req.status(),
                    req == null ? null : req.body(),
                    req == null ? null : req.error(),
                    req == null ? null : req.formValues(),
                    req != null && req.durationMs() != null ? req.durationMs() : 0L,
                    recorder(executionId));
        } catch (Exception e) {
            cleanupSuspension(executionId, suspended); // 예외 경로에서도 인덱스 정리(누수 방지)
            execution.markFailed("재개 중 오류: " + msg(e));
            executionRepo.save(execution);
            return detail(execution, null, null);
        }
        applyStatus(execution, outcome);
        rememberIfPending(executionId, outcome, suspended.state(), suspended.tenant());
        executionRepo.save(execution);
        return detail(execution, outcome.pendingClient(), outcome.pendingForm());
    }

    /**
     * 고정(사전등록) 콜백 수신 — 게이트웨이가 안정 URL({@code {{ __notiUrl }}})로 보낸 결과.
     * 파라미터 값들 중 등록된 상관키(corrId)로 대기 실행을 찾아 <b>서버 사이드로 재개</b>한다(브라우저 불필요).
     * 브라우저 팝업이 병행 중이어도 재개는 멱등하므로 안전하다.
     */
    public Map<String, Object> recordFixedCallback(Map<String, String[]> rawParams) {
        Map<String, Object> params = flattenParams(rawParams);
        UUID execId = matchByCorr(params);
        if (execId == null) {
            throw new BadRequestException("매칭되는 대기 실행이 없습니다(상관키 미포함/만료).");
        }
        Suspended suspended = suspensions.get(execId);
        if (suspended == null) {
            throw new BadRequestException("대기 중이 아닌 콜백입니다.");
        }
        String prev = TenantContext.getTenantId();
        try {
            TenantContext.setTenantId(suspended.tenant());
            doResume(execId, suspended, new ResumeRequest(null, null, null, null, params, null));
        } finally {
            if (prev != null) {
                TenantContext.setTenantId(prev);
            } else {
                TenantContext.clear();
            }
        }
        return params;
    }

    /** 파라미터 값들(문자열/리스트) 중 등록된 corrId 가 있으면 그 실행 id. 없으면 null. */
    private UUID matchByCorr(Map<String, Object> params) {
        for (Object v : params.values()) {
            if (v instanceof String s) {
                UUID id = corrIds.get(s);
                if (id != null) {
                    return id;
                }
            } else if (v instanceof List<?> list) {
                for (Object item : list) {
                    if (item instanceof String s && corrIds.get(s) != null) {
                        return corrIds.get(s);
                    }
                }
            }
        }
        return null;
    }

    private void cleanupSuspension(UUID execId, Suspended s) {
        suspensions.remove(execId);
        if (s.callbackToken() != null) {
            callbackTokens.remove(s.callbackToken());
        }
        if (s.corrId() != null) {
            corrIds.remove(s.corrId());
        }
    }

    @Transactional(readOnly = true)
    public ExecutionDetail get(UUID executionId) {
        Execution e = executionRepo.findByIdAndTenantId(executionId, TenantContext.getTenantId())
                .orElseThrow(() -> NotFoundException.of("Execution", executionId));
        return detail(e, null, null);
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

    /** 중단(pending)되면 재개 상태를 보관하고, 그 외(완료/실패)면 비운다. 콜백 토큰·상관키 인덱스도 함께 관리. */
    private void rememberIfPending(UUID execId, FlowExecutor.Outcome outcome,
                                   FlowExecutor.RunState state, String tenant) {
        // 직전 토큰/상관키가 있으면 정리(재개로 상태가 넘어갈 때 스테일 인덱스 제거)
        Suspended prev = suspensions.get(execId);
        if (prev != null) {
            if (prev.callbackToken() != null) {
                callbackTokens.remove(prev.callbackToken());
            }
            if (prev.corrId() != null) {
                corrIds.remove(prev.corrId());
            }
        }
        if (outcome.status() == ExecutionStatus.WAITING && outcome.isPending()) {
            FlowExecutor.PendingForm pf = outcome.pendingForm();
            String token = pf != null ? pf.callbackToken() : null;
            String corr = pf != null ? pf.corrId() : null;
            suspensions.put(execId, new Suspended(state, tenant, token, corr));
            if (token != null) {
                callbackTokens.put(token, execId);
            }
            if (corr != null) {
                corrIds.put(corr, execId);
            }
        } else {
            suspensions.remove(execId);
        }
    }

    /**
     * 게이트웨이/팝업이 콜백 URL 로 리다이렉트(GET 쿼리 또는 POST 자동전송)했을 때 호출된다.
     * 토큰으로 실행/테넌트를 되찾아 파라미터를 재개 상태에 저장(authoritative)한다. 재개(resume)는
     * 브라우저 브리지 페이지의 postMessage 가 몰고 오므로 여기서는 하지 않는다.
     */
    public Map<String, Object> recordCallback(String token, Map<String, String[]> rawParams) {
        UUID execId = callbackTokens.get(token);
        if (execId == null) {
            throw new BadRequestException("만료되었거나 알 수 없는 콜백입니다.");
        }
        Suspended suspended = suspensions.get(execId);
        if (suspended == null) {
            throw new BadRequestException("대기 중이 아닌 콜백입니다.");
        }
        Map<String, Object> params = flattenParams(rawParams);
        String prev = TenantContext.getTenantId();
        try {
            TenantContext.setTenantId(suspended.tenant());
            flowExecutor.recordCallback(suspended.state(), params);
        } finally {
            if (prev != null) {
                TenantContext.setTenantId(prev);
            } else {
                TenantContext.clear();
            }
        }
        return params;
    }

    /** 서블릿 파라미터맵(값 배열)을 단일값/리스트 맵으로 평탄화 — parseForm 의 중복키 규약과 동일. */
    private static Map<String, Object> flattenParams(Map<String, String[]> raw) {
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        if (raw == null) {
            return out;
        }
        for (Map.Entry<String, String[]> e : raw.entrySet()) {
            String[] vals = e.getValue();
            if (vals == null || vals.length == 0) {
                out.put(e.getKey(), "");
            } else if (vals.length == 1) {
                out.put(e.getKey(), vals[0]);
            } else {
                out.put(e.getKey(), List.of(vals));
            }
        }
        return out;
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

    private ExecutionDetail detail(Execution e, FlowExecutor.PendingClient pending, FlowExecutor.PendingForm form) {
        List<NodeExecutionView> nodes = nodeExecRepo.findByExecutionIdOrderBySeqAsc(e.getId())
                .stream().map(this::toView).toList();
        PendingClientRequest pc = pending == null ? null : new PendingClientRequest(
                pending.nodeId(), pending.nodeName(), pending.method(), pending.url(),
                pending.headers(), pending.body(), pending.respType());
        PendingFormRequest pf = form == null ? null : new PendingFormRequest(
                form.nodeId(), form.nodeName(), form.action(), form.method(),
                (form.fields() == null ? List.<FlowExecutor.PendingForm.Field>of() : form.fields()).stream()
                        .map(f -> new PendingFormRequest.FormField(f.key(), f.value())).toList());
        return new ExecutionDetail(e.getId(), e.getFlowId(), e.getFlowVersionId(), e.getStatus(),
                e.getTrigger(), e.getTriggeredBy(), e.getStartedAt(), e.getFinishedAt(), e.getError(), nodes, pc, pf);
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
