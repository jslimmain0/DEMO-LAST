package com.flowlink.execution.engine;

import com.flowlink.common.json.JsonService;
import com.flowlink.core.domain.ExecutionStatus;
import com.flowlink.core.domain.NodeExecutionStatus;
import com.flowlink.core.graph.FlowGraph;
import com.flowlink.core.graph.GraphEdge;
import com.flowlink.core.graph.GraphNode;
import com.flowlink.core.graph.NodeField;
import com.flowlink.core.graph.NodeType;
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

/**
 * 워크플로 그래프를 위상정렬 순서로 실행하는 동기 오케스트레이터.
 * 프로토타입 runFlow 의 의미(도달 노드만 실행, IF는 선택 분기만 진행, 첫 실패 시 중단)를 서버에서 재현한다.
 *
 * <p>WAIT(휴먼태스크) 노드를 만나면 실행을 WAITING 으로 일시중단한다. (내구성 재개는 후속 Phase)
 */
@Component
public class FlowExecutor {

    private final TokenResolver tokens;
    private final ExpressionEvaluator evaluator;
    private final HttpNodeExecutor httpExecutor;
    private final JsonService json;
    private final com.flowlink.transform.TransformRegistry transformRegistry;
    private final TcpNodeExecutor tcpExecutor;

    public FlowExecutor(TokenResolver tokens, ExpressionEvaluator evaluator,
                        HttpNodeExecutor httpExecutor, JsonService json,
                        com.flowlink.transform.TransformRegistry transformRegistry,
                        TcpNodeExecutor tcpExecutor) {
        this.tokens = tokens;
        this.evaluator = evaluator;
        this.httpExecutor = httpExecutor;
        this.json = json;
        this.transformRegistry = transformRegistry;
        this.tcpExecutor = tcpExecutor;
    }

    public record Outcome(ExecutionStatus status, String error, PendingClient pending) {
        static Outcome succeeded() {
            return new Outcome(ExecutionStatus.SUCCEEDED, null, null);
        }

        static Outcome failed(String error) {
            return new Outcome(ExecutionStatus.FAILED, error, null);
        }

        static Outcome waiting() {
            return new Outcome(ExecutionStatus.WAITING, null, null);
        }

        static Outcome pendingClient(PendingClient pc) {
            return new Outcome(ExecutionStatus.WAITING, null, pc);
        }
    }

    /** client 모드 HTTP 노드에서 중단할 때, 브라우저가 대신 호출하도록 넘기는 조립된 요청. */
    public record PendingClient(String nodeId, String nodeName, String method, String url,
                                Map<String, String> headers, String body, String respType) {
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
        private String pendingClientNodeId;

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

    /** 브라우저(client 모드)가 돌려준 결과를 중단 지점 노드에 적재하고 이어서 실행한다. */
    public Outcome resume(RunState st, String nodeId, int status, String body, String error,
                          long durationMs, NodeRecorder recorder) {
        if (st.pendingClientNodeId == null) {
            return drive(st, recorder); // 중단 상태가 아니면 방어적으로 계속 진행
        }
        GraphNode node = st.byId.get(st.pendingClientNodeId);
        HttpNodeExecutor.BuiltRequest req = httpExecutor.build(node, st.ctx);
        NodeResult result = httpExecutor.clientResult(node, req, status, body, error);

        st.ctx.putOutput(node.id(), result.value());
        if (result.reqValues() != null) {
            st.ctx.putRequest(node.id(), result.reqValues());
        }
        recorder.record(node, st.seq++, result,
                result.ok() ? NodeExecutionStatus.SUCCEEDED : NodeExecutionStatus.FAILED, durationMs);
        st.pendingClientNodeId = null;

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

            if (node.nodeType() == NodeType.WAIT) {
                recorder.record(node, st.seq++, waitResult(node), NodeExecutionStatus.WAITING, 0);
                return Outcome.waiting();
            }

            // client 모드 HTTP 노드: 서버가 호출하지 않고 브라우저로 위임 → WAITING 으로 중단
            if (node.nodeType() == NodeType.HTTP && isClientMode(node)) {
                HttpNodeExecutor.BuiltRequest req = httpExecutor.build(node, st.ctx);
                st.pendingClientNodeId = id;
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
