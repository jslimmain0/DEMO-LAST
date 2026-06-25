package com.flowlink.execution.engine;

import com.flowlink.common.json.JsonService;
import com.flowlink.core.domain.ExecutionStatus;
import com.flowlink.core.domain.NodeExecutionStatus;
import com.flowlink.core.graph.FlowGraph;
import com.flowlink.core.graph.GraphEdge;
import com.flowlink.core.graph.GraphNode;
import com.flowlink.core.graph.NodeType;
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

    public FlowExecutor(TokenResolver tokens, ExpressionEvaluator evaluator,
                        HttpNodeExecutor httpExecutor, JsonService json) {
        this.tokens = tokens;
        this.evaluator = evaluator;
        this.httpExecutor = httpExecutor;
        this.json = json;
    }

    public record Outcome(ExecutionStatus status, String error) {
    }

    public Outcome execute(FlowGraph graph, ExecutionContext ctx, NodeRecorder recorder) {
        List<GraphNode> nodes = graph.nodesOrEmpty();
        List<GraphEdge> edges = graph.edgesOrEmpty();
        Map<String, GraphNode> byId = new HashMap<>();
        nodes.forEach(n -> byId.put(n.id(), n));

        List<String> order = topoOrder(nodes, edges);
        Set<String> active = initialActive(nodes, edges);

        int seq = 0;
        for (String id : order) {
            GraphNode node = byId.get(id);
            if (node == null) {
                continue;
            }
            if (!active.contains(id)) {
                recorder.record(node, seq++, NodeResult.ok(null, "(미실행)", "분기 미선택으로 건너뜀", null),
                        NodeExecutionStatus.SKIPPED, 0);
                continue;
            }

            if (node.nodeType() == NodeType.WAIT) {
                recorder.record(node, seq++, waitResult(node), NodeExecutionStatus.WAITING, 0);
                return new Outcome(ExecutionStatus.WAITING, null);
            }

            long t0 = System.nanoTime();
            NodeResult result;
            try {
                result = processNode(node, ctx);
            } catch (Exception e) {
                result = NodeResult.fail(0, "", "⚠ " + (e.getMessage() == null ? e.toString() : e.getMessage()));
            }
            long durationMs = (System.nanoTime() - t0) / 1_000_000;

            ctx.putOutput(id, result.value());
            if (result.reqValues() != null) {
                ctx.putRequest(id, result.reqValues());
            }

            recorder.record(node, seq++, result,
                    result.ok() ? NodeExecutionStatus.SUCCEEDED : NodeExecutionStatus.FAILED, durationMs);

            if (!result.ok()) {
                return new Outcome(ExecutionStatus.FAILED,
                        "노드 실패: " + node.name() + " — " + truncate(result.responseText()));
            }

            // 다운스트림 활성화: IF는 선택 분기만
            String taken = node.nodeType() == NodeType.IF ? result.branch() : null;
            for (GraphEdge e : edges) {
                if (!id.equals(e.from())) {
                    continue;
                }
                if (taken != null && !taken.equals(e.fromPortOrDefault())) {
                    continue;
                }
                active.add(e.to());
            }
        }
        return new Outcome(ExecutionStatus.SUCCEEDED, null);
    }

    private NodeResult processNode(GraphNode node, ExecutionContext ctx) {
        return switch (node.nodeType()) {
            case START -> NodeResult.ok(null, "(시작)", "플로우 시작", Map.of());
            case END -> NodeResult.ok(null, "(끝)", "플로우 종료", Map.of());
            case SET -> setNode(node, ctx);
            case IF -> ifNode(node, ctx);
            case HTTP -> httpExecutor.execute(node, ctx);
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
