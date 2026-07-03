package com.flowlink.execution.engine;

import com.flowlink.common.json.JsonService;
import com.flowlink.core.domain.ExecutionStatus;
import com.flowlink.core.domain.NodeExecutionStatus;
import com.flowlink.core.graph.FlowGraph;
import com.flowlink.core.graph.GraphEdge;
import com.flowlink.core.graph.GraphNode;
import com.flowlink.core.graph.NodeField;
import com.flowlink.core.graph.NodeType;
import com.flowlink.core.graph.WaitField;
import com.flowlink.execution.config.ExecutionProperties;
import com.flowlink.transform.FlowTransform;
import com.flowlink.core.graph.NodeVar;
import org.springframework.stereotype.Component;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * 워크플로 그래프를 위상정렬 순서로 실행하는 동기 오케스트레이터.
 * 프로토타입 runFlow 의 의미(도달 노드만 실행, IF는 선택 분기만 진행, 첫 실패 시 중단)를 서버에서 재현한다.
 *
 * <p>중단(WAITING) 지점 3종 + client HTTP:
 * <ul>
 *   <li><b>FORM</b>(폼 전송) — 브라우저가 팝업을 열고 폼을 submit 하면 즉시 재개(fire-and-forget).
 *       기다리는 것은 다음 WAIT 노드의 몫.</li>
 *   <li><b>WAIT</b>(콜백 대기) — {@code {base}/api/v1/cb/{실행ID}/{노드ID}} 수신까지 대기(타임아웃).
 *       수신 URL 은 실행 시작 시점에 확정되어 {@code {{ url@노드ID }}} 로 앞쪽 노드에서도 바인딩 가능.
 *       콜백이 먼저 도착하면 버퍼({@link CallbackRegistry})에서 즉시 소비한다.</li>
 *   <li><b>INPUT</b>(사용자 입력 대기) — 브라우저가 입력 창을 띄우고 제출한 값이 노드 출력이 된다.</li>
 * </ul>
 */
@Component
public class FlowExecutor {

    private final TokenResolver tokens;
    private final ExpressionEvaluator evaluator;
    private final HttpNodeExecutor httpExecutor;
    private final JsonService json;
    private final com.flowlink.transform.TransformRegistry transformRegistry;
    private final TcpNodeExecutor tcpExecutor;
    private final ExecutionProperties props;
    private final CallbackRegistry callbacks;

    public FlowExecutor(TokenResolver tokens, ExpressionEvaluator evaluator,
                        HttpNodeExecutor httpExecutor, JsonService json,
                        com.flowlink.transform.TransformRegistry transformRegistry,
                        TcpNodeExecutor tcpExecutor, ExecutionProperties props,
                        CallbackRegistry callbacks) {
        this.tokens = tokens;
        this.evaluator = evaluator;
        this.httpExecutor = httpExecutor;
        this.json = json;
        this.transformRegistry = transformRegistry;
        this.tcpExecutor = tcpExecutor;
        this.props = props;
        this.callbacks = callbacks;
    }

    public record Outcome(ExecutionStatus status, String error, PendingClient pendingClient,
                          PendingForm pendingForm, PendingInput pendingInput, PendingWait pendingWait) {
        static Outcome succeeded() {
            return new Outcome(ExecutionStatus.SUCCEEDED, null, null, null, null, null);
        }

        static Outcome failed(String error) {
            return new Outcome(ExecutionStatus.FAILED, error, null, null, null, null);
        }

        static Outcome pendingClient(PendingClient pc) {
            return new Outcome(ExecutionStatus.WAITING, null, pc, null, null, null);
        }

        static Outcome pendingForm(PendingForm pf) {
            return new Outcome(ExecutionStatus.WAITING, null, null, pf, null, null);
        }

        static Outcome pendingInput(PendingInput pi) {
            return new Outcome(ExecutionStatus.WAITING, null, null, null, pi, null);
        }

        static Outcome pendingWait(PendingWait pw) {
            return new Outcome(ExecutionStatus.WAITING, null, null, null, null, pw);
        }

        public boolean isPending() {
            return pendingClient != null || pendingForm != null || pendingInput != null || pendingWait != null;
        }

        /** 중단을 유발한 노드 id(대기 아님이면 null). */
        public String pendingNodeId() {
            if (pendingClient != null) {
                return pendingClient.nodeId();
            }
            if (pendingForm != null) {
                return pendingForm.nodeId();
            }
            if (pendingInput != null) {
                return pendingInput.nodeId();
            }
            if (pendingWait != null) {
                return pendingWait.nodeId();
            }
            return null;
        }
    }

    /** client 모드 HTTP 노드에서 중단할 때, 브라우저가 대신 호출하도록 넘기는 조립된 요청. */
    public record PendingClient(String nodeId, String nodeName, String method, String url,
                                Map<String, String> headers, String body, String respType) {
    }

    /** 폼 전송(FORM) 노드에서 중단할 때, 브라우저가 새 창(팝업)으로 target 전송할 폼 명세(값은 해석 완료). */
    public record PendingForm(String nodeId, String nodeName, String action, String method, List<Field> fields) {
        public record Field(String key, String value) {
        }
    }

    /** 사용자 입력 대기(INPUT) 노드에서 중단할 때, 브라우저가 띄울 입력 창 명세. */
    public record PendingInput(String nodeId, String nodeName, String msg, List<Field> fields) {
        public record Field(String key, String label) {
        }
    }

    /** 콜백 대기(WAIT) 노드에서 중단할 때의 대기 정보 — 수신 URL 과 타임아웃. */
    public record PendingWait(String nodeId, String nodeName, String url, int timeoutSec) {
    }

    /**
     * 재개 가능한 실행 진행 상태(인메모리). 중단 노드에서 WAITING 으로 멈췄다가
     * {@link #resume} 으로 이어서 실행한다. (서버 단일 인스턴스/세션 한정 — 내구성 보관은 후속 Phase)
     */
    public static final class RunState {
        private final UUID execId;
        private final List<GraphEdge> edges;
        private final Map<String, GraphNode> byId;
        private final List<String> order;
        private final Set<String> active;
        private final ExecutionContext ctx;
        /** wait(콜백 대기) 노드별 수신 URL — 실행 시작 시점에 확정(실행마다 고유). */
        private final Map<String, String> waitUrls;
        private int index;
        private int seq;
        private String pendingNodeId; // 중단(재개 대기) 중인 노드

        private RunState(UUID execId, List<GraphEdge> edges, Map<String, GraphNode> byId, List<String> order,
                         Set<String> active, ExecutionContext ctx, Map<String, String> waitUrls) {
            this.execId = execId;
            this.edges = edges;
            this.byId = byId;
            this.order = order;
            this.active = active;
            this.ctx = ctx;
            this.waitUrls = waitUrls;
        }

        public ExecutionContext context() {
            return ctx;
        }

        public String pendingNodeId() {
            return pendingNodeId;
        }
    }

    /**
     * 새 실행 상태를 만든다. wait(콜백 대기) 노드가 있으면:
     * <ul>
     *   <li>수신 URL {@code {base}/api/v1/cb/{실행ID}/{노드ID}} 를 확정해 ctx 에
     *       {@code {url: ...}} 출력으로 시드 → 앞쪽 노드에서도 {@code {{ url@노드ID }}} 바인딩 가능.</li>
     *   <li>노드에 설정된 "콜백에 줄 응답"(형식/본문)을 토큰 치환(실행 시작 시점) 후 레지스트리에 등록.</li>
     * </ul>
     */
    public RunState newRun(FlowGraph graph, ExecutionContext ctx, UUID execId) {
        List<GraphNode> nodes = graph.nodesOrEmpty();
        List<GraphEdge> edges = graph.edgesOrEmpty();
        Map<String, GraphNode> byId = new HashMap<>();
        nodes.forEach(n -> byId.put(n.id(), n));
        List<String> order = topoOrder(nodes, edges);
        Set<String> active = initialActive(nodes, edges);

        Map<String, String> waitUrls = new HashMap<>();
        if (execId != null) {
            for (GraphNode n : nodes) {
                if (n.effectiveType() == NodeType.WAIT) {
                    String url = props.callback().baseUrl() + "/api/v1/cb/" + execId + "/" + n.id();
                    waitUrls.put(n.id(), url);
                    ctx.putOutput(n.id(), Map.of("url", url));
                }
            }
            // 응답 등록은 URL 시드 이후 — 응답 본문이 {{ url@… }} 를 참조할 수 있다.
            for (GraphNode n : nodes) {
                if (n.effectiveType() == NodeType.WAIT) {
                    callbacks.registerReply(execId, n.id(), replyOf(n, ctx));
                }
            }
        }
        return new RunState(execId, edges, byId, order, active, ctx, waitUrls);
    }

    private CallbackRegistry.Reply replyOf(GraphNode n, ExecutionContext ctx) {
        String type = n.cbRespType() == null ? "text" : n.cbRespType().toLowerCase();
        String contentType = switch (type) {
            case "html" -> "text/html;charset=UTF-8";
            case "json" -> "application/json;charset=UTF-8";
            default -> "text/plain;charset=UTF-8";
        };
        String body = n.cbRespBody() == null || n.cbRespBody().isBlank()
                ? "OK" : tokens.resolveTokens(n.cbRespBody(), ctx);
        return new CallbackRegistry.Reply(contentType, body);
    }

    /** 처음부터 실행한다(편의 오버로드 — 재개가 필요 없는 호출/테스트용, 콜백 대기 미지원). */
    public Outcome execute(FlowGraph graph, ExecutionContext ctx, NodeRecorder recorder) {
        return drive(newRun(graph, ctx, null), recorder);
    }

    public Outcome execute(RunState state, NodeRecorder recorder) {
        return drive(state, recorder);
    }

    /**
     * 중단 지점 노드에 재개 입력을 적재하고 이어서 실행한다.
     * FORM → 팝업 submit 성공/차단, INPUT → 사용자가 입력한 값, WAIT → 버퍼의 콜백 수신분,
     * client HTTP → 브라우저가 돌려준 응답.
     */
    public Outcome resume(RunState st, Integer httpStatus, String httpBody, String httpError,
                          Map<String, Object> formValues, long durationMs, NodeRecorder recorder) {
        if (st.pendingNodeId == null) {
            return drive(st, recorder); // 중단 상태가 아니면 방어적으로 계속 진행
        }
        GraphNode node = st.byId.get(st.pendingNodeId);
        NodeType et = node.effectiveType();
        NodeResult result;
        switch (et) {
            case FORM -> {
                // 브라우저가 팝업을 열고 submit 한 결과 — error 가 있으면(팝업 차단 등) 노드 실패
                String reqText = formLogText(formSpec(node, st));
                if (httpError != null && !httpError.isBlank()) {
                    result = NodeResult.fail(0, reqText, httpError);
                } else {
                    result = NodeResult.ok(null, reqText, "팝업을 열고 form을 submit 했습니다", Map.of());
                }
            }
            case INPUT -> {
                Map<String, Object> values = formValues == null ? Map.of() : formValues;
                result = NodeResult.ok(null, "(사용자 입력)", json.toJson(values), values);
            }
            case WAIT -> {
                // 콜백은 항상 레지스트리에 먼저 버퍼되고, 재개는 그 1건을 소비한다(FIFO).
                CallbackRegistry.Received r = callbacks.poll(st.execId, node.id());
                Map<String, Object> values = r != null ? r.values()
                        : (formValues == null ? Map.of() : formValues);
                String reqText = r != null ? (r.method() + " " + r.url()) : "(콜백 수신)";
                String resText = r != null && r.rawBody() != null && !r.rawBody().isBlank()
                        ? r.rawBody() : json.toJson(values);
                result = NodeResult.ok(null, reqText, resText, values);
            }
            default -> {
                // client 모드 HTTP
                HttpNodeExecutor.BuiltRequest req = httpExecutor.build(node, st.ctx);
                result = httpExecutor.clientResult(node, req, httpStatus == null ? 0 : httpStatus, httpBody, httpError);
            }
        }

        st.ctx.putOutput(node.id(), result.value());
        if (result.reqValues() != null) {
            st.ctx.putRequest(node.id(), result.reqValues());
        }
        recorder.record(node, st.seq++, result,
                result.ok() ? NodeExecutionStatus.SUCCEEDED : NodeExecutionStatus.FAILED, durationMs);
        st.pendingNodeId = null;

        if (!result.ok()) {
            return Outcome.failed("노드 실패: " + node.name() + " — " + truncate(result.responseText()));
        }
        activateDownstream(st, node, null);
        st.index++; // 중단을 유발한 노드는 처리 완료 → 다음 노드부터
        return drive(st, recorder);
    }

    /**
     * 대기 중인 노드를 실패로 기록하고 실행을 종료시킨다 — 타임아웃 등 서버측 종료용.
     * (재개 없이 대기가 끝나는 유일한 경로이므로 노드 로그를 여기서 남긴다)
     */
    public Outcome failPending(RunState st, String error, NodeRecorder recorder) {
        if (st.pendingNodeId == null) {
            return Outcome.failed(error);
        }
        GraphNode node = st.byId.get(st.pendingNodeId);
        NodeResult result = NodeResult.fail(0, "(콜백 대기)", error);
        recorder.record(node, st.seq++, result, NodeExecutionStatus.FAILED, 0);
        st.pendingNodeId = null;
        return Outcome.failed("노드 실패: " + node.name() + " — " + error);
    }

    private Outcome drive(RunState st, NodeRecorder recorder) {
        for (; st.index < st.order.size(); st.index++) {
            String id = st.order.get(st.index);
            GraphNode node = st.byId.get(id);
            if (node == null) {
                continue;
            }
            if (!st.active.contains(id)) {
                recorder.record(node, st.seq++, NodeResult.ok(null, "(미실행)", "분기 미선택으로 건너뜀", null),
                        NodeExecutionStatus.SKIPPED, 0);
                continue;
            }

            NodeType et = node.effectiveType();

            // 폼 전송(FORM): 브라우저가 팝업을 열고 submit 하도록 잠시 중단 — submit 직후 재개(fire-and-forget)
            if (et == NodeType.FORM) {
                PendingForm spec = formSpec(node, st);
                if (spec.action() == null || spec.action().isBlank()) {
                    NodeResult fail = NodeResult.fail(0, formLogText(spec), "팝업 URL이 비어 있습니다");
                    recorder.record(node, st.seq++, fail, NodeExecutionStatus.FAILED, 0);
                    return Outcome.failed("노드 실패: " + node.name() + " — 팝업 URL이 비어 있습니다");
                }
                st.pendingNodeId = id;
                return Outcome.pendingForm(spec);
            }

            // 콜백 대기(WAIT): 이미 도착한 콜백이 버퍼에 있으면 즉시 소비, 없으면 수신까지 중단
            if (et == NodeType.WAIT) {
                CallbackRegistry.Received r = st.execId == null ? null : callbacks.poll(st.execId, id);
                if (r != null) {
                    String resText = r.rawBody() != null && !r.rawBody().isBlank()
                            ? r.rawBody() : json.toJson(r.values());
                    NodeResult result = NodeResult.ok(null, r.method() + " " + r.url(), resText, r.values());
                    st.ctx.putOutput(id, result.value());
                    recorder.record(node, st.seq++, result, NodeExecutionStatus.SUCCEEDED, 0);
                    activateDownstream(st, node, null);
                    continue;
                }
                st.pendingNodeId = id;
                String url = st.waitUrls.get(id);
                if (url == null) {
                    NodeResult fail = NodeResult.fail(0, "(콜백 대기)", "수신 URL 미확정 — 재개 불가 컨텍스트");
                    recorder.record(node, st.seq++, fail, NodeExecutionStatus.FAILED, 0);
                    return Outcome.failed("노드 실패: " + node.name() + " — 수신 URL 미확정");
                }
                return Outcome.pendingWait(new PendingWait(id, node.name(), url, timeoutSecOf(node)));
            }

            // 사용자 입력 대기(INPUT): 브라우저가 입력 창을 띄우도록 중단
            if (et == NodeType.INPUT) {
                List<PendingInput.Field> fields = new ArrayList<>();
                if (node.waitFields() != null) {
                    for (WaitField wf : node.waitFields()) {
                        if (wf.key() != null && !wf.key().isBlank()) {
                            fields.add(new PendingInput.Field(wf.key(), wf.label()));
                        }
                    }
                }
                if (fields.isEmpty()) {
                    fields.add(new PendingInput.Field("value", null)); // 프로토타입 호환 폴백
                }
                st.pendingNodeId = id;
                return Outcome.pendingInput(new PendingInput(id, node.name(), node.waitMsg(), fields));
            }

            // client 모드 HTTP 노드: 서버가 호출하지 않고 브라우저로 위임 → WAITING 으로 중단
            if (et == NodeType.HTTP && isClientMode(node)) {
                HttpNodeExecutor.BuiltRequest req = httpExecutor.build(node, st.ctx);
                st.pendingNodeId = id;
                PendingClient pc = new PendingClient(id, node.name(), req.method(), req.url(),
                        req.headers(), req.body(), node.respType() == null ? "json" : node.respType());
                return Outcome.pendingClient(pc);
            }

            long t0 = System.nanoTime();
            NodeResult result;
            try {
                result = processNode(node, st.ctx);
            } catch (Exception e) {
                result = NodeResult.fail(0, "", "⚠ " + (e.getMessage() == null ? e.toString() : e.getMessage()));
            }
            long durationMs = (System.nanoTime() - t0) / 1_000_000;

            st.ctx.putOutput(id, result.value());
            if (result.reqValues() != null) {
                st.ctx.putRequest(id, result.reqValues());
            }

            recorder.record(node, st.seq++, result,
                    result.ok() ? NodeExecutionStatus.SUCCEEDED : NodeExecutionStatus.FAILED, durationMs);

            if (!result.ok()) {
                return Outcome.failed("노드 실패: " + node.name() + " — " + truncate(result.responseText()));
            }

            // 다운스트림 활성화: IF는 선택 분기만
            String taken = et == NodeType.IF ? result.branch() : null;
            activateDownstream(st, node, taken);
        }
        return Outcome.succeeded();
    }

    /** wait 노드 타임아웃(초). 미설정/0 이하면 기본 120. */
    public static int timeoutSecOf(GraphNode node) {
        Integer t = node.waitTimeoutSec();
        return t == null || t <= 0 ? 120 : t;
    }

    /** FORM 노드의 action/필드를 해석해 팝업 폼 명세를 만든다(값은 바인딩·토큰 해석 완료). */
    private PendingForm formSpec(GraphNode node, RunState st) {
        String action = tokens.resolveTokens(node.formAction() == null ? "" : node.formAction(), st.ctx);
        String method = node.formMethod() == null ? "POST" : node.formMethod().toUpperCase();
        List<PendingForm.Field> ff = new ArrayList<>();
        if (Boolean.TRUE.equals(node.jsonRaw())) {
            // Raw 모드: 폼 데이터를 a=1&b=2 원문으로 입력 → 필드로 분해(토큰 해석)
            String raw = node.rawBody() == null ? "" : node.rawBody();
            for (String pair : raw.split("&")) {
                if (pair.isBlank()) {
                    continue;
                }
                int eq = pair.indexOf('=');
                String k = (eq >= 0 ? pair.substring(0, eq) : pair).trim();
                if (k.isEmpty()) {
                    continue;
                }
                ff.add(new PendingForm.Field(k,
                        tokens.resolveTokens(eq >= 0 ? pair.substring(eq + 1) : "", st.ctx)));
            }
        } else {
            for (NodeField f : node.fieldsOrEmpty().bodyOrEmpty()) {
                if (f.key() != null && !f.key().isBlank()) {
                    String v = f.bound() != null
                            ? tokens.stringify(tokens.fieldValue(f, st.ctx))
                            : tokens.resolveTokens(f.value() == null ? "" : f.value(), st.ctx);
                    ff.add(new PendingForm.Field(f.key(), v));
                }
            }
        }
        return new PendingForm(node.id(), node.name(), action, method, ff);
    }

    /** 실행 로그용 폼 요약 — method·URL·hidden 필드 전체(줄 단위). */
    private static String formLogText(PendingForm spec) {
        StringBuilder sb = new StringBuilder(spec.method()).append(' ').append(spec.action());
        for (PendingForm.Field f : spec.fields()) {
            sb.append('\n').append(f.key()).append('=').append(f.value());
        }
        return sb.toString();
    }

    private void activateDownstream(RunState st, GraphNode node, String takenBranch) {
        for (GraphEdge e : st.edges) {
            if (!node.id().equals(e.from())) {
                continue;
            }
            if (takenBranch != null && !takenBranch.equals(e.fromPortOrDefault())) {
                continue;
            }
            st.active.add(e.to());
        }
    }

    private static boolean isClientMode(GraphNode node) {
        return "client".equalsIgnoreCase(node.reqMode());
    }

    private NodeResult processNode(GraphNode node, ExecutionContext ctx) {
        return switch (node.nodeType()) {
            case START -> NodeResult.ok(null, "(시작)", "플로우 시작", Map.of());
            case END -> NodeResult.ok(null, "(끝)", "플로우 종료", Map.of());
            case SET -> setNode(node, ctx);
            case IF -> ifNode(node, ctx);
            case HTTP -> httpExecutor.execute(node, ctx);
            case TRANSFORM -> transformNode(node, ctx);
            case TCP -> tcpExecutor.execute(node, ctx);
            // FORM/WAIT/INPUT 은 정상 흐름에선 drive()에서 선처리됨 — 방어적 플레이스홀더
            case FORM, WAIT, INPUT -> NodeResult.fail(0, "", "대기형 노드는 실행 중단 경로로만 처리됩니다");
            case UNKNOWN -> NodeResult.fail(0, "", "지원하지 않는 노드 타입: " + node.type());
        };
    }

    private NodeResult setNode(GraphNode node, ExecutionContext ctx) {
        Map<String, Object> value = new LinkedHashMap<>();
        Map<String, Object> masked = new LinkedHashMap<>();
        List<NodeVar> vars = node.vars() == null ? List.of() : node.vars();
        for (NodeVar v : vars) {
            if (v.key() == null || v.key().isBlank()) {
                continue;
            }
            Object val = v.bound() != null ? tokens.resolveBinding(v.bound(), ctx) : v.value();
            value.put(v.key(), val);
            masked.put(v.key(), v.secret() ? "••••••" : val);
        }
        return new NodeResult(true, null, "(변수 저장)", json.toJson(masked), value, masked, null, null);
    }

    private NodeResult ifNode(GraphNode node, ExecutionContext ctx) {
        boolean result = evaluator.evaluateBoolean(node.condition(), ctx);
        String branch = result ? "true" : "false";
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("result", result);
        value.put("branch", branch);
        return NodeResult.ok(null, "if ( " + (node.condition() == null ? "" : node.condition()) + " )",
                json.toJson(value), value).withBranch(branch);
    }

    private NodeResult transformNode(GraphNode node, ExecutionContext ctx) {
        var found = transformRegistry.get(node.transformId() == null ? "" : node.transformId());
        if (found.isEmpty()) {
            return NodeResult.fail(0, "transform " + node.transformId(), "알 수 없는 변환: " + node.transformId());
        }
        FlowTransform transform = found.get();

        // 선언된 입력 포트별로 fields.body 의 동일 key 행을 찾아 값(바인딩/리터럴)을 해석
        Map<String, NodeField> byKey = new HashMap<>();
        for (NodeField f : node.fieldsOrEmpty().bodyOrEmpty()) {
            if (f.key() != null && !f.key().isBlank()) {
                byKey.put(f.key(), f);
            }
        }
        Map<String, String> inputs = new LinkedHashMap<>();
        for (FlowTransform.IoSpec in : transform.inputs()) {
            NodeField f = byKey.get(in.key());
            inputs.put(in.key(), f == null ? "" : tokens.stringify(tokens.fieldValue(f, ctx)));
        }

        Map<String, String> config = node.config() == null ? Map.of() : node.config();
        Map<String, String> out;
        try {
            out = transform.apply(inputs, config);
        } catch (Exception e) {
            return NodeResult.fail(0, "transform " + transform.id(),
                    "변환 실패: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
        Map<String, Object> value = new LinkedHashMap<>(out == null ? Map.of() : out);
        return NodeResult.ok(null, "transform " + transform.id() + " in=" + inputs, json.toJson(value), value);
    }

    // --- 위상정렬 (Kahn) ---
    private List<String> topoOrder(List<GraphNode> nodes, List<GraphEdge> edges) {
        Map<String, Integer> indeg = new HashMap<>();
        Map<String, List<String>> adj = new HashMap<>();
        nodes.forEach(n -> {
            indeg.put(n.id(), 0);
            adj.put(n.id(), new ArrayList<>());
        });
        for (GraphEdge e : edges) {
            if (adj.containsKey(e.from()) && indeg.containsKey(e.to())) {
                adj.get(e.from()).add(e.to());
                indeg.merge(e.to(), 1, Integer::sum);
            }
        }
        Deque<String> queue = new ArrayDeque<>();
        nodes.forEach(n -> {
            if (indeg.get(n.id()) == 0) {
                queue.add(n.id());
            }
        });
        List<String> order = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        while (!queue.isEmpty()) {
            String id = queue.poll();
            if (!seen.add(id)) {
                continue;
            }
            order.add(id);
            for (String t : adj.get(id)) {
                indeg.merge(t, -1, Integer::sum);
                if (indeg.get(t) <= 0) {
                    queue.add(t);
                }
            }
        }
        // 사이클 등으로 남은 노드는 뒤에 덧붙임(프로토타입과 동일)
        nodes.forEach(n -> {
            if (!seen.contains(n.id())) {
                order.add(n.id());
            }
        });
        return order;
    }

    private Set<String> initialActive(List<GraphNode> nodes, List<GraphEdge> edges) {
        Map<String, Integer> indeg = new HashMap<>();
        nodes.forEach(n -> indeg.put(n.id(), 0));
        for (GraphEdge e : edges) {
            if (indeg.containsKey(e.to())) {
                indeg.merge(e.to(), 1, Integer::sum);
            }
        }
        Set<String> active = new HashSet<>();
        nodes.forEach(n -> {
            if (indeg.get(n.id()) == 0) {
                active.add(n.id());
            }
        });
        return active;
    }

    private static String truncate(String s) {
        if (s == null) {
            return "";
        }
        return s.length() > 300 ? s.substring(0, 300) + "…" : s;
    }
}
