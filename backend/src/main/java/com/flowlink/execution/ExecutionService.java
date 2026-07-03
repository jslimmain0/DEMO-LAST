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
import com.flowlink.execution.dto.PendingInputRequest;
import com.flowlink.execution.dto.PendingWaitRequest;
import com.flowlink.execution.dto.ResumeRequest;
import com.flowlink.execution.dto.RunRequest;
import com.flowlink.execution.engine.CallbackRegistry;
import com.flowlink.execution.engine.ExecutionContext;
import com.flowlink.execution.engine.FlowExecutor;
import com.flowlink.execution.engine.NodeRecorder;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * 워크플로 실행의 진입점 + 영속화 경계 + 콜백 relay 라우팅.
 *
 * <p>주의(Phase 1): 동기 실행이다 — 호출 스레드가 모든 노드(외부 HTTP 포함)를 끝까지 수행한다.
 * 운영용 비동기 큐/워커(at-least-once)·내구성 실행은 후속 Phase. DB 트랜잭션을 외부 호출 동안
 * 길게 잡지 않도록, 노드별 결과는 짧은 독립 트랜잭션으로 즉시 저장한다(run() 은 비트랜잭션).
 *
 * <p><b>콜백 대기(wait) 재개 주체는 서버다</b> — 콜백이 {@code /cb/{실행ID}/{노드ID}} 로 도착하면
 * 이 서비스가 대기 중인 실행을 직접 재개하고, 브라우저(에디터)는 폴링으로 진행을 관전한다.
 * 콜백이 wait 도달 전에 오면 {@link CallbackRegistry} 버퍼에 쌓였다가 도달/등록 직후 소비된다.
 */
@Service
public class ExecutionService {

    private static final Logger log = LoggerFactory.getLogger(ExecutionService.class);

    private final FlowRepository flowRepo;
    private final FlowVersionRepository versionRepo;
    private final ExecutionRepository executionRepo;
    private final NodeExecutionRepository nodeExecRepo;
    private final FlowExecutor flowExecutor;
    private final CallbackRegistry callbacks;
    private final JsonService json;
    private final ObjectMapper mapper;
    private final ExecutionProperties props;

    /**
     * 중단(WAITING)된 실행의 재개 상태(인메모리). 단일 인스턴스/세션 한정 —
     * 서버 재시작 시 소실되며 내구성 보관은 후속 Phase.
     */
    private final Map<UUID, Suspended> suspensions = new ConcurrentHashMap<>();

    /** wait(콜백 대기) 타임아웃 타이머 — 재개/취소 시 해제. */
    private final Map<UUID, ScheduledFuture<?>> timeouts = new ConcurrentHashMap<>();

    /** 서스펜션 클레임(콜백/브라우저/타임아웃 경쟁)과 버퍼 라우팅의 원자성 보장. */
    private final Object lock = new Object();

    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "flowlink-wait-timeout");
        t.setDaemon(true);
        return t;
    });

    private enum Kind { CLIENT, FORM, INPUT, WAIT }

    /** 중단 상태 스냅샷 — outcome 은 폴링(GET) 응답에 pending 정보를 되살리는 데 쓴다. */
    private record Suspended(FlowExecutor.RunState state, String tenant, String nodeId, Kind kind,
                             FlowExecutor.Outcome outcome) {
    }

    public ExecutionService(FlowRepository flowRepo, FlowVersionRepository versionRepo,
                            ExecutionRepository executionRepo, NodeExecutionRepository nodeExecRepo,
                            FlowExecutor flowExecutor, CallbackRegistry callbacks,
                            JsonService json, ExecutionProperties props) {
        this.flowRepo = flowRepo;
        this.versionRepo = versionRepo;
        this.executionRepo = executionRepo;
        this.nodeExecRepo = nodeExecRepo;
        this.flowExecutor = flowExecutor;
        this.callbacks = callbacks;
        this.json = json;
        this.mapper = json.mapper();
        this.props = props;
    }

    @PreDestroy
    void shutdown() {
        scheduler.shutdownNow();
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
        FlowExecutor.RunState state = flowExecutor.newRun(graph, ctx, execId);

        FlowExecutor.Outcome outcome;
        try {
            outcome = flowExecutor.execute(state, recorder(execId));
        } catch (Exception e) {
            execution.markFailed("실행 중 오류: " + msg(e));
            executionRepo.save(execution);
            callbacks.cleanup(execId);
            return detail(execution, null);
        }
        applyStatus(execution, outcome);
        rememberIfPending(execId, outcome, state, tenant);
        executionRepo.save(execution);
        return drainBuffered(execId, detail(execution, outcome));
    }

    /**
     * 중단된 실행을 브라우저가 돌려준 입력으로 재개한다 — FORM(팝업 submit 결과)/INPUT(입력 값)/client HTTP.
     * wait(콜백 대기)는 브라우저가 재개할 수 없다(콜백 또는 타임아웃만) — 그 경우 현재 상태를 그대로 반환(멱등).
     */
    public ExecutionDetail resume(UUID executionId, ResumeRequest req) {
        String tenant = TenantContext.getTenantId();
        Suspended claimed = null;
        synchronized (lock) {
            Suspended s = suspensions.get(executionId);
            if (s != null && s.tenant().equals(tenant) && s.kind() != Kind.WAIT) {
                suspensions.remove(executionId);
                claimed = s;
            }
        }
        if (claimed == null) {
            // 멱등: 이미 재개/완료됐거나, wait(콜백 대기)라 브라우저가 재개할 수 없는 경우 — 현재 상태 반환.
            Execution existing = executionRepo.findByIdAndTenantId(executionId, tenant)
                    .orElseThrow(() -> NotFoundException.of("Execution", executionId));
            return detail(existing, pendingOutcomeOf(executionId, tenant));
        }
        return drainBuffered(executionId, doResume(executionId, claimed, req));
    }

    /** 사용자가 대기 중 실행을 중단(⏹)한다 — 서스펜션 해제 + CANCELLED. 대기 아님이면 현재 상태(멱등). */
    public ExecutionDetail cancel(UUID executionId) {
        String tenant = TenantContext.getTenantId();
        Execution execution = executionRepo.findByIdAndTenantId(executionId, tenant)
                .orElseThrow(() -> NotFoundException.of("Execution", executionId));
        Suspended claimed = null;
        synchronized (lock) {
            Suspended s = suspensions.get(executionId);
            if (s != null && s.tenant().equals(tenant)) {
                suspensions.remove(executionId);
                claimed = s;
            }
        }
        cancelTimeout(executionId);
        if (claimed != null) {
            execution.markCancelled();
            executionRepo.save(execution);
            callbacks.cleanup(executionId);
        }
        return detail(execution, null);
    }

    /**
     * 콜백 수신부(relay) — {@code ANY /cb/{실행ID}/{노드ID}}. 항상 버퍼에 먼저 쌓고,
     * 그 노드에서 대기 중이면 서버가 직접 재개한다(브라우저 불필요). 반환값은 그 wait 노드에
     * 등록된 응답(미등록이면 text/plain "OK") — 게이트웨이/팝업이 그대로 받는다.
     */
    public CallbackRegistry.Reply recordNodeCallback(UUID execId, String nodeId, String method, String url,
                                                     Map<String, String[]> rawParams,
                                                     String rawBody) {
        CallbackRegistry.Reply reply = callbacks.reply(execId, nodeId);
        if (!executionRepo.existsById(execId)) {
            return reply; // 알 수 없는 실행 — 버퍼 오염 방지(응답은 관용적으로 반환)
        }
        Map<String, Object> values = parseCallback(rawParams, rawBody);
        callbacks.buffer(execId, nodeId, new CallbackRegistry.Received(values, rawBody, method, url));

        Suspended claimed = null;
        synchronized (lock) {
            Suspended s = suspensions.get(execId);
            if (s != null && s.kind() == Kind.WAIT && nodeId.equals(s.nodeId())) {
                suspensions.remove(execId);
                claimed = s;
            }
        }
        if (claimed != null) {
            cancelTimeout(execId);
            String prev = TenantContext.getTenantId();
            try {
                TenantContext.setTenantId(claimed.tenant());
                ExecutionDetail d = doResume(execId, claimed,
                        new ResumeRequest(nodeId, null, null, null, null, null));
                drainBuffered(execId, d);
            } finally {
                if (prev != null) {
                    TenantContext.setTenantId(prev);
                } else {
                    TenantContext.clear();
                }
            }
        }
        return reply;
    }

    /** 재개 실행 + 상태반영 + 영속화 공통 경로. 브라우저 resume / 서버측 콜백 재개 / 드레인이 공유한다. */
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
            cancelTimeout(executionId);
            callbacks.cleanup(executionId);
            execution.markFailed("재개 중 오류: " + msg(e));
            executionRepo.save(execution);
            return detail(execution, null);
        }
        applyStatus(execution, outcome);
        rememberIfPending(executionId, outcome, suspended.state(), suspended.tenant());
        executionRepo.save(execution);
        return detail(execution, outcome);
    }

    /**
     * wait 서스펜션 등록과 콜백 도착 사이의 갭 방어 — 등록 직후 버퍼를 재확인해,
     * 이미 도착해 있으면 즉시 소비(재개)한다. 재개가 또 다른 wait 에 도달할 수 있으므로 루프.
     */
    private ExecutionDetail drainBuffered(UUID execId, ExecutionDetail current) {
        while (true) {
            Suspended claimed = null;
            synchronized (lock) {
                Suspended s = suspensions.get(execId);
                if (s != null && s.kind() == Kind.WAIT && callbacks.hasBuffered(execId, s.nodeId())) {
                    suspensions.remove(execId);
                    claimed = s;
                }
            }
            if (claimed == null) {
                return current;
            }
            cancelTimeout(execId);
            current = doResume(execId, claimed,
                    new ResumeRequest(claimed.nodeId(), null, null, null, null, null));
        }
    }

    @Transactional(readOnly = true)
    public ExecutionDetail get(UUID executionId) {
        String tenant = TenantContext.getTenantId();
        Execution e = executionRepo.findByIdAndTenantId(executionId, tenant)
                .orElseThrow(() -> NotFoundException.of("Execution", executionId));
        // 폴링(관전) 응답에도 pending 정보를 되살린다 — 새로고침/재진입 시 카운트다운·입력창 복원용.
        return detail(e, pendingOutcomeOf(executionId, tenant));
    }

    private FlowExecutor.Outcome pendingOutcomeOf(UUID executionId, String tenant) {
        Suspended s = suspensions.get(executionId);
        return s != null && s.tenant().equals(tenant) ? s.outcome() : null;
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

    /** 중단(pending)되면 재개 상태를 보관하고(wait 이면 타임아웃 예약), 그 외(완료/실패)면 정리한다. */
    private void rememberIfPending(UUID execId, FlowExecutor.Outcome outcome,
                                   FlowExecutor.RunState state, String tenant) {
        if (outcome.status() == ExecutionStatus.WAITING && outcome.isPending()) {
            Kind kind = outcome.pendingWait() != null ? Kind.WAIT
                    : outcome.pendingForm() != null ? Kind.FORM
                    : outcome.pendingInput() != null ? Kind.INPUT
                    : Kind.CLIENT;
            synchronized (lock) {
                suspensions.put(execId, new Suspended(state, tenant, outcome.pendingNodeId(), kind, outcome));
            }
            if (kind == Kind.WAIT) {
                scheduleTimeout(execId, outcome.pendingWait(), tenant);
            } else {
                cancelTimeout(execId);
            }
        } else {
            synchronized (lock) {
                suspensions.remove(execId);
            }
            cancelTimeout(execId);
            callbacks.cleanup(execId); // 실행 종료 — 이 실행의 버퍼/응답 정리
        }
    }

    private void scheduleTimeout(UUID execId, FlowExecutor.PendingWait pw, String tenant) {
        cancelTimeout(execId);
        timeouts.put(execId, scheduler.schedule(
                () -> onTimeout(execId, pw.nodeId(), pw.timeoutSec(), tenant),
                pw.timeoutSec(), TimeUnit.SECONDS));
    }

    private void cancelTimeout(UUID execId) {
        ScheduledFuture<?> f = timeouts.remove(execId);
        if (f != null) {
            f.cancel(false);
        }
    }

    /** wait 타임아웃 — 아직 그 노드에서 대기 중이면 노드 FAILED 기록 + 실행 FAILED. */
    private void onTimeout(UUID execId, String nodeId, int timeoutSec, String tenant) {
        Suspended claimed = null;
        synchronized (lock) {
            Suspended s = suspensions.get(execId);
            if (s != null && s.kind() == Kind.WAIT && nodeId.equals(s.nodeId())) {
                suspensions.remove(execId);
                claimed = s;
            }
        }
        timeouts.remove(execId);
        if (claimed == null) {
            return; // 이미 콜백/취소로 처리됨
        }
        String prev = TenantContext.getTenantId();
        try {
            TenantContext.setTenantId(tenant);
            FlowExecutor.Outcome outcome = flowExecutor.failPending(claimed.state(),
                    "타임아웃 — " + timeoutSec + "초 동안 콜백이 오지 않았습니다", recorder(execId));
            executionRepo.findByIdAndTenantId(execId, tenant).ifPresent(execution -> {
                execution.markFailed(outcome.error());
                executionRepo.save(execution);
            });
            callbacks.cleanup(execId);
        } catch (Exception e) {
            log.warn("wait 타임아웃 처리 실패 execId={}", execId, e);
        } finally {
            if (prev != null) {
                TenantContext.setTenantId(prev);
            } else {
                TenantContext.clear();
            }
        }
    }

    /**
     * 콜백 본문 파싱 — JSON({,[," 시작)이면 JSON, 아니면 a=1&b=2 형태면 urlencoded 객체, 둘 다 아니면
     * {@code body} 키에 원문. 서블릿 파라미터(GET 쿼리 + urlencoded POST)는 항상 베이스로 병합한다.
     */
    private Map<String, Object> parseCallback(Map<String, String[]> rawParams, String rawBody) {
        Map<String, Object> out = flattenParams(rawParams);
        if (rawBody == null || rawBody.isBlank()) {
            return out;
        }
        String t = rawBody.trim();
        if (t.startsWith("{") || t.startsWith("[") || t.startsWith("\"")) {
            try {
                Object parsed = mapper.readValue(t, Object.class);
                if (parsed instanceof Map<?, ?> m) {
                    m.forEach((k, v) -> out.put(String.valueOf(k), v));
                } else {
                    out.put("body", parsed);
                }
                return out;
            } catch (Exception ignore) {
                // JSON 실패 → 아래 form/원문 폴백
            }
        }
        Map<String, Object> formParsed = tryParseForm(t);
        if (formParsed != null) {
            out.putAll(formParsed);
        } else {
            out.put("body", rawBody);
        }
        return out;
    }

    /** {@code a=1&b=2} 형태면 키-값 맵(percent 디코딩), 아니면 null. */
    private static Map<String, Object> tryParseForm(String t) {
        if (t.indexOf('=') < 0 || t.contains("\n")) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        for (String pair : t.split("&")) {
            if (pair.isBlank()) {
                continue;
            }
            int eq = pair.indexOf('=');
            if (eq <= 0) {
                return null; // 키 없는 조각 → form 아님
            }
            try {
                String k = URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8);
                String v = URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
                out.put(k, v);
            } catch (IllegalArgumentException e) {
                return null; // 잘못된 인코딩 → form 아님
            }
        }
        return out.isEmpty() ? null : out;
    }

    /** 서블릿 파라미터맵(값 배열)을 단일값/리스트 맵으로 평탄화 — parseForm 의 중복키 규약과 동일. */
    private static Map<String, Object> flattenParams(Map<String, String[]> raw) {
        Map<String, Object> out = new LinkedHashMap<>();
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

    private ExecutionDetail detail(Execution e, FlowExecutor.Outcome outcome) {
        List<NodeExecutionView> nodes = nodeExecRepo.findByExecutionIdOrderBySeqAsc(e.getId())
                .stream().map(this::toView).toList();
        PendingClientRequest pc = null;
        PendingFormRequest pf = null;
        PendingInputRequest pi = null;
        PendingWaitRequest pw = null;
        if (outcome != null) {
            if (outcome.pendingClient() != null) {
                var p = outcome.pendingClient();
                pc = new PendingClientRequest(p.nodeId(), p.nodeName(), p.method(), p.url(),
                        p.headers(), p.body(), p.respType());
            }
            if (outcome.pendingForm() != null) {
                var p = outcome.pendingForm();
                pf = new PendingFormRequest(p.nodeId(), p.nodeName(), p.action(), p.method(),
                        (p.fields() == null ? List.<FlowExecutor.PendingForm.Field>of() : p.fields()).stream()
                                .map(f -> new PendingFormRequest.FormField(f.key(), f.value())).toList());
            }
            if (outcome.pendingInput() != null) {
                var p = outcome.pendingInput();
                pi = new PendingInputRequest(p.nodeId(), p.nodeName(), p.msg(),
                        (p.fields() == null ? List.<FlowExecutor.PendingInput.Field>of() : p.fields()).stream()
                                .map(f -> new PendingInputRequest.InputField(f.key(), f.label())).toList());
            }
            if (outcome.pendingWait() != null) {
                var p = outcome.pendingWait();
                pw = new PendingWaitRequest(p.nodeId(), p.nodeName(), p.url(), p.timeoutSec());
            }
        }
        return new ExecutionDetail(e.getId(), e.getFlowId(), e.getFlowVersionId(), e.getStatus(),
                e.getTrigger(), e.getTriggeredBy(), e.getStartedAt(), e.getFinishedAt(), e.getError(),
                nodes, pc, pf, pi, pw);
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
