package com.flowlink.execution.engine;

import com.flowlink.common.json.JsonService;
import com.flowlink.core.domain.ExecutionStatus;
import com.flowlink.core.domain.NodeExecutionStatus;
import com.flowlink.core.graph.FlowGraph;
import com.flowlink.core.graph.GraphEdge;
import com.flowlink.core.graph.GraphNode;
import com.flowlink.core.graph.NodeField;
import com.flowlink.core.graph.NodeType;
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
import java.util.regex.Pattern;

/**
 * 워크플로 그래프를 위상정렬 순서로 실행하는 동기 오케스트레이터.
 * 프로토타입 runFlow 의 의미(도달 노드만 실행, IF는 선택 분기만 진행, 첫 실패 시 중단)를 서버에서 재현한다.
 *
 * <p>WAIT(휴먼태스크) 노드를 만나면 실행을 WAITING 으로 일시중단한다. (내구성 재개는 후속 Phase)
 */
@Component
public class FlowExecutor {

    /** 폼 전송 노드 특수 토큰. 서버가 실행 시 실제 값으로 치환한다. */
    static final Pattern CALLBACK_TOKEN = Pattern.compile("\\{\\{\\s*__callbackUrl\\s*}}"); // 동적: per-run 토큰 URL
    static final Pattern NOTI_URL = Pattern.compile("\\{\\{\\s*__notiUrl\\s*}}");            // 고정: 사전등록용 안정 URL
    static final Pattern CORR_ID = Pattern.compile("\\{\\{\\s*__corrId\\s*}}");              // 상관키: 고정 URL 매칭용

    private final TokenResolver tokens;
    private final ExpressionEvaluator evaluator;
    private final HttpNodeExecutor httpExecutor;
    private final JsonService json;
    private final com.flowlink.transform.TransformRegistry transformRegistry;
    private final TcpNodeExecutor tcpExecutor;
    private final ExecutionProperties props;

    public FlowExecutor(TokenResolver tokens, ExpressionEvaluator evaluator,
                        HttpNodeExecutor httpExecutor, JsonService json,
                        com.flowlink.transform.TransformRegistry transformRegistry,
                        TcpNodeExecutor tcpExecutor, ExecutionProperties props) {
        this.tokens = tokens;
        this.evaluator = evaluator;
        this.httpExecutor = httpExecutor;
        this.json = json;
        this.transformRegistry = transformRegistry;
        this.tcpExecutor = tcpExecutor;
        this.props = props;
    }

    public record Outcome(ExecutionStatus status, String error, PendingClient pendingClient, PendingForm pendingForm) {
        static Outcome succeeded() {
            return new Outcome(ExecutionStatus.SUCCEEDED, null, null, null);
        }

        static Outcome failed(String error) {
            return new Outcome(ExecutionStatus.FAILED, error, null, null);
        }

        static Outcome waiting() {
            return new Outcome(ExecutionStatus.WAITING, null, null, null);
        }

        static Outcome pendingClient(PendingClient pc) {
            return new Outcome(ExecutionStatus.WAITING, null, pc, null);
        }

        static Outcome pendingForm(PendingForm pf) {
            return new Outcome(ExecutionStatus.WAITING, null, null, pf);
        }

        public boolean isPending() {
            return pendingClient != null || pendingForm != null;
        }
    }

    /** client 모드 HTTP 노드에서 중단할 때, 브라우저가 대신 호출하도록 넘기는 조립된 요청. */
    public record PendingClient(String nodeId, String nodeName, String method, String url,
                                Map<String, String> headers, String body, String respType) {
    }

    /**
     * 폼 전송 노드에서 중단할 때, 브라우저가 새 창(팝업)으로 target 전송할 폼 명세(값은 해석 완료).
     * {@code callbackToken} 은 이 노드가 {@code {{ __callbackUrl }}} 을 쓸 때만 발급된다(아니면 null) —
     * ExecutionService 가 token→execId 등록에 쓰며 클라이언트 DTO 로는 노출하지 않는다(서버 내부).
     */
    public record PendingForm(String nodeId, String nodeName, String action, String method,
                              List<Field> fields, String callbackToken, String corrId) {
        public record Field(String key, String value) {
        }
    }

    /**
     * 재개 가능한 실행 진행 상태(인메모리). client 노드에서 WAITING 으로 중단했다가
     * {@link #resume} 으로 이어서 실행한다. (서버 단일 인스턴스/세션 한정 — 내구성 보관은 후속 Phase)
     */
    public static final class RunState {
        private final List<GraphEdge> edges;
        private final Map<String, GraphNode> byId;
        private final List<String> order;
        private final Set<String> active;
        private final ExecutionContext ctx;
        private int index;
        private int seq;
        private String pendingNodeId; // 중단(재개 대기) 중인 노드 — client HTTP 또는 WAIT(폼)
        // 게이트웨이 콜백: 폼 필드에 {{ __callbackUrl }} 이 있으면 발급되는 수신 토큰/URL 과
        // 게이트웨이가 콜백 엔드포인트로 되돌려준 파라미터(수신 즉시 저장 → postMessage 유실에도 재개 가능).
        private String callbackToken;
        private String callbackUrl;
        private Map<String, Object> callbackParams;
        // 고정(사전등록) 콜백: 안정 URL({{ __notiUrl }})과 실행 매칭용 상관키({{ __corrId }}).
        // 고정 URL 은 실행마다 안 바뀌므로, 게이트웨이가 echo 하는 corrId 값으로 대기 중인 실행을 찾는다.
        private String corrId;
        private String notiUrl;

        private RunState(List<GraphEdge> edges, Map<String, GraphNode> byId, List<String> order,
                         Set<String> active, ExecutionContext ctx) {
            this.edges = edges;
            this.byId = byId;
            this.order = order;
            this.active = active;
            this.ctx = ctx;
        }

        public ExecutionContext context() {
            return ctx;
        }
    }

    public RunState newRun(FlowGraph graph, ExecutionContext ctx) {
        List<GraphNode> nodes = graph.nodesOrEmpty();
        List<GraphEdge> edges = graph.edgesOrEmpty();
        Map<String, GraphNode> byId = new HashMap<>();
        nodes.forEach(n -> byId.put(n.id(), n));
        List<String> order = topoOrder(nodes, edges);
        Set<String> active = initialActive(nodes, edges);
        return new RunState(edges, byId, order, active, ctx);
    }

    /** 처음부터 실행한다(편의 오버로드 — 재개가 필요 없는 호출/테스트용). */
    public Outcome execute(FlowGraph graph, ExecutionContext ctx, NodeRecorder recorder) {
        return drive(newRun(graph, ctx), recorder);
    }

    public Outcome execute(RunState state, NodeRecorder recorder) {
        return drive(state, recorder);
    }

    /**
     * 중단 지점 노드에 재개 입력을 적재하고 이어서 실행한다.
     * WAIT(폼) → 제출한 값이 노드 출력이 되고, client HTTP → 브라우저가 돌려준 응답이 결과가 된다.
     */
    public Outcome resume(RunState st, Integer httpStatus, String httpBody, String httpError,
                          Map<String, Object> formValues, long durationMs, NodeRecorder recorder) {
        if (st.pendingNodeId == null) {
            return drive(st, recorder); // 중단 상태가 아니면 방어적으로 계속 진행
        }
        GraphNode node = st.byId.get(st.pendingNodeId);
        NodeResult result;
        if (node.nodeType() == NodeType.WAIT) {
            // 콜백 스레드(recordCallback)가 기록한 파라미터를 happens-before 로 읽는다.
            Map<String, Object> callbackParams;
            synchronized (st) {
                callbackParams = st.callbackParams;
            }
            // 실제 폼 입력이 없고(빈 값 또는 팝업 닫힘 신호 {closed:true}) 게이트웨이 콜백이 도착해 있으면
            // 그 값을 노드 출력으로(방어적 폴백 — postMessage 유실/차단 시에도 authoritative 결과 반영).
            Map<String, Object> values;
            if (isNoFormInput(formValues) && callbackParams != null) {
                values = callbackParams;
            } else {
                values = formValues == null ? Map.of() : formValues;
            }
            result = NodeResult.ok(null, "(폼 입력)", json.toJson(values), values);
            synchronized (st) {
                st.callbackToken = null;
                st.callbackUrl = null;
                st.callbackParams = null;
                st.corrId = null;
                st.notiUrl = null;
            }
        } else {
            HttpNodeExecutor.BuiltRequest req = httpExecutor.build(node, st.ctx);
            result = httpExecutor.clientResult(node, req, httpStatus == null ? 0 : httpStatus, httpBody, httpError);
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

            // 폼 전송 노드: 브라우저가 새 창(팝업)으로 폼을 target 전송하도록 WAITING 으로 중단
            if (node.nodeType() == NodeType.WAIT) {
                st.pendingNodeId = id;
                st.callbackParams = null;
                // 동적 콜백: {{ __callbackUrl }} 이 있으면 per-run 토큰 URL 을 발급(브라우저 팝업 복귀용).
                if (referencesToken(node, CALLBACK_TOKEN)) {
                    st.callbackToken = UUID.randomUUID().toString().replace("-", "");
                    st.callbackUrl = props.callback().baseUrl() + "/api/v1/executions/callback/" + st.callbackToken;
                } else {
                    st.callbackToken = null;
                    st.callbackUrl = null;
                }
                // 고정 콜백: {{ __notiUrl }}/{{ __corrId }} 가 있으면 안정 URL + 상관키를 발급(사전등록·서버 노티용).
                if (referencesToken(node, NOTI_URL) || referencesToken(node, CORR_ID)) {
                    st.corrId = UUID.randomUUID().toString().replace("-", "");
                    st.notiUrl = props.callback().baseUrl() + "/api/v1/callbacks";
                } else {
                    st.corrId = null;
                    st.notiUrl = null;
                }
                String action = resolveFormValue(node.formAction() == null ? "" : node.formAction(), st);
                String method = node.formMethod() == null ? "POST" : node.formMethod().toUpperCase();
                List<PendingForm.Field> ff = new ArrayList<>();
                if (Boolean.TRUE.equals(node.jsonRaw())) {
                    // Raw 모드: 폼 데이터를 a=1&b=2 원문으로 입력 → 필드로 분해(콜백 치환 + 토큰 해석)
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
                        ff.add(new PendingForm.Field(k, resolveFormValue(eq >= 0 ? pair.substring(eq + 1) : "", st)));
                    }
                } else {
                    for (NodeField f : node.fieldsOrEmpty().bodyOrEmpty()) {
                        if (f.key() != null && !f.key().isBlank()) {
                            ff.add(new PendingForm.Field(f.key(), resolveFormFieldValue(f, st)));
                        }
                    }
                }
                return Outcome.pendingForm(new PendingForm(id, node.name(), action, method, ff, st.callbackToken, st.corrId));
            }

            // client 모드 HTTP 노드: 서버가 호출하지 않고 브라우저로 위임 → WAITING 으로 중단
            if (node.nodeType() == NodeType.HTTP && isClientMode(node)) {
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
            String taken = node.nodeType() == NodeType.IF ? result.branch() : null;
            activateDownstream(st, node, taken);
        }
        return Outcome.succeeded();
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

    /** 폼 전송 노드의 action/필드/Raw 어디든 주어진 특수 토큰을 참조하는지. */
    private static boolean referencesToken(GraphNode node, Pattern p) {
        if (hasRef(node.formAction(), p)) {
            return true;
        }
        if (Boolean.TRUE.equals(node.jsonRaw()) && hasRef(node.rawBody(), p)) {
            return true; // Raw 폼 데이터 모드
        }
        for (NodeField f : node.fieldsOrEmpty().bodyOrEmpty()) {
            if (f.bound() == null && hasRef(f.value(), p)) {
                return true;
            }
        }
        return false;
    }

    private static boolean hasRef(String s, Pattern p) {
        return s != null && p.matcher(s).find();
    }

    /** 문자열 리터럴에서 특수 토큰(__callbackUrl/__notiUrl/__corrId)을 먼저 치환하고 나머지 토큰을 해석. */
    private String resolveFormValue(String raw, RunState st) {
        if (raw == null) {
            return tokens.resolveTokens("", st.ctx);
        }
        raw = substitute(raw, CALLBACK_TOKEN, st.callbackUrl);
        raw = substitute(raw, NOTI_URL, st.notiUrl);
        raw = substitute(raw, CORR_ID, st.corrId);
        return tokens.resolveTokens(raw, st.ctx);
    }

    private static String substitute(String raw, Pattern p, String value) {
        if (value == null || !p.matcher(raw).find()) {
            return raw;
        }
        return p.matcher(raw).replaceAll(java.util.regex.Matcher.quoteReplacement(value));
    }

    /** 폼 필드 값 — 바인딩이면 그 값, 리터럴이면 특수 토큰 치환 + 토큰 해석. */
    private String resolveFormFieldValue(NodeField f, RunState st) {
        if (f.bound() != null) {
            return tokens.stringify(tokens.fieldValue(f, st.ctx));
        }
        return resolveFormValue(f.value(), st);
    }

    /**
     * 게이트웨이가 콜백 엔드포인트로 되돌려준 파라미터를 재개 상태에 저장한다(수신 즉시, authoritative).
     * 브라우저의 postMessage/재개가 유실돼도 이 값으로 WAIT 노드를 완료할 수 있다. (ExecutionService 가 호출)
     *
     * <p>콜백은 별도 서블릿 스레드에서 도착하므로 {@code resume} 의 읽기와 happens-before 를 맺도록 {@code st} 로 동기화한다.
     */
    public void recordCallback(RunState st, Map<String, Object> params) {
        synchronized (st) {
            st.callbackParams = params;
        }
    }

    /** 실제 폼 입력이 없는가 — 비었거나 팝업 닫힘 신호({closed:true})만 있는 경우(콜백 폴백 트리거). */
    private static boolean isNoFormInput(Map<String, Object> formValues) {
        if (formValues == null || formValues.isEmpty()) {
            return true;
        }
        return formValues.size() == 1 && Boolean.TRUE.equals(formValues.get("closed"));
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
            case WAIT -> waitResult(node); // 정상 흐름에선 execute()에서 선처리됨
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

    private NodeResult waitResult(GraphNode node) {
        String msg = node.waitMsg() == null ? "입력 대기" : node.waitMsg();
        return new NodeResult(true, null, "(대기) " + msg,
                "외부 입력 대기 중 — 내구성 재개는 후속 Phase", Map.of(), Map.of(), null, null);
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
