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

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
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
 * <p>브라우저 협업이 필요한 노드는 WAITING 으로 일시중단하고 pending 명세를 넘긴다:
 * client 모드 HTTP(브라우저가 대신 호출) · form(팝업으로 폼 제출, submit 즉시 재개) ·
 * wait(relay 수신 URL 로 콜백/노티가 올 때까지 대기 — 타임아웃/중단도 브라우저가 resume 으로 알린다).
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

    public record Outcome(ExecutionStatus status, String error, PendingClient pendingClient,
                          PendingForm pendingForm, PendingWait pendingWait, PendingInput pendingInput) {
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

        static Outcome pendingWait(PendingWait pw) {
            return new Outcome(ExecutionStatus.WAITING, null, null, null, pw, null);
        }

        static Outcome pendingInput(PendingInput pi) {
            return new Outcome(ExecutionStatus.WAITING, null, null, null, null, pi);
        }

        public boolean isPending() {
            return pendingClient != null || pendingForm != null || pendingWait != null || pendingInput != null;
        }
    }

    /** client 모드 HTTP 노드에서 중단할 때, 브라우저가 대신 호출하도록 넘기는 조립된 요청. */
    public record PendingClient(String nodeId, String nodeName, String method, String url,
                                Map<String, String> headers, String body, String respType) {
    }

    /** form(팝업) 노드에서 중단할 때, 브라우저가 팝업으로 제출할 폼 명세(값은 해석 완료). */
    public record PendingForm(String nodeId, String nodeName, String action, String method,
                              List<Field> fields) {
        public record Field(String key, String value) {
        }
    }

    /** wait(콜백 대기) 노드에서 중단할 때 넘기는 대기 명세. receiveUrl 은 relay 미연동이면 null. */
    public record PendingWait(String nodeId, String nodeName, int timeoutSec, String receiveUrl) {
    }

    /** input(사용자 입력) 노드에서 중단할 때, 브라우저가 모달로 띄울 입력 명세. */
    public record PendingInput(String nodeId, String nodeName, String message, List<Field> fields) {
        public record Field(String key, String label, String type) {
        }
    }

    /**
     * 재개 입력 — ExecutionService 가 dto ResumeRequest 를 이 형태로 옮겨 넘긴다.
     * client HTTP 는 httpStatus/body/error, form 은 popupOpened/error, wait 는 callback/error.
     */
    public record ResumeInput(Integer httpStatus, String body, String error,
                              Boolean popupOpened, Callback callback, Map<String, Object> formValues) {
        public record Callback(String method, String url, Map<String, String> headers, String body) {
        }
    }

    /**
     * 재개 가능한 실행 진행 상태(인메모리). 브라우저 협업 노드에서 WAITING 으로 중단했다가
     * {@link #resume} 으로 이어서 실행한다. (서버 단일 인스턴스/세션 한정 — 내구성 보관은 후속 Phase)
     */
    public static final class RunState {
        private final List<GraphEdge> edges;
        private final Map<String, GraphNode> byId;
        private final List<String> order;
        private final Set<String> active;
        private final ExecutionContext ctx;
        // 콜백 수신 URL 조립용 — 브라우저가 실행 직전에 만든 relay 실행ID/주소 (없으면 null)
        private final String relayBase;
        private final String relayRunId;
        private int index;
        private int seq;
        private String pendingNodeId; // 중단(재개 대기) 중인 노드 — client HTTP / form / wait
        private PendingForm pendingFormSpec; // form 중단 시 해석 완료된 폼 명세(재개 로그·요청값용)

        private RunState(List<GraphEdge> edges, Map<String, GraphNode> byId, List<String> order,
                         Set<String> active, ExecutionContext ctx, String relayBase, String relayRunId) {
            this.edges = edges;
            this.byId = byId;
            this.order = order;
            this.active = active;
            this.ctx = ctx;
            this.relayBase = relayBase;
            this.relayRunId = relayRunId;
        }

        public ExecutionContext context() {
            return ctx;
        }
    }

    public RunState newRun(FlowGraph graph, ExecutionContext ctx) {
        return newRun(graph, ctx, null, null);
    }

    public RunState newRun(FlowGraph graph, ExecutionContext ctx, String relayBase, String relayRunId) {
        List<GraphNode> nodes = graph.nodesOrEmpty();
        List<GraphEdge> edges = graph.edgesOrEmpty();
        Map<String, GraphNode> byId = new HashMap<>();
        nodes.forEach(n -> byId.put(n.id(), n));
        List<String> order = topoOrder(nodes, edges);
        Set<String> active = initialActive(nodes, edges);
        return new RunState(edges, byId, order, active, ctx, relayBase, relayRunId);
    }

    /** wait 노드의 콜백 수신 URL — {relayBase}/cb/{relayRunId}/{nodeId}. relay 미연동이면 null. */
    public static String receiveUrl(String relayBase, String relayRunId, String nodeId) {
        if (relayBase == null || relayBase.isBlank() || relayRunId == null || relayRunId.isBlank()) {
            return null;
        }
        String base = relayBase.endsWith("/") ? relayBase.substring(0, relayBase.length() - 1) : relayBase;
        return base + "/cb/" + relayRunId + "/" + nodeId;
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
     * form → 팝업 submit 확인 후 즉시 진행, wait → 수신 콜백 본문이 노드 출력이 되고,
     * client HTTP → 브라우저가 돌려준 응답이 결과가 된다.
     */
    public Outcome resume(RunState st, ResumeInput in, long durationMs, NodeRecorder recorder) {
        if (st.pendingNodeId == null) {
            return drive(st, recorder); // 중단 상태가 아니면 방어적으로 계속 진행
        }
        GraphNode node = st.byId.get(st.pendingNodeId);
        NodeType et = node.effectiveType();
        NodeResult result;
        if (et == NodeType.FORM) {
            result = formResumeResult(st, in);
        } else if (et == NodeType.WAIT) {
            result = waitResumeResult(node, st, in);
        } else if (et == NodeType.INPUT) {
            result = inputResumeResult(node, in);
        } else {
            HttpNodeExecutor.BuiltRequest req = httpExecutor.build(node, st.ctx);
            result = httpExecutor.clientResult(node, req,
                    in == null || in.httpStatus() == null ? 0 : in.httpStatus(),
                    in == null ? null : in.body(),
                    in == null ? null : in.error());
        }
        st.pendingFormSpec = null;

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

            NodeType et = node.effectiveType();

            // form(팝업) 노드: 브라우저가 팝업으로 form 을 제출하도록 중단 — submit 후 즉시 재개(기다리지 않음)
            if (et == NodeType.FORM) {
                String method = node.formMethod() == null ? "POST" : node.formMethod().toUpperCase();
                String action = tokens.resolveTokens(node.formAction() == null ? "" : node.formAction(), st.ctx).trim();
                List<PendingForm.Field> ff = formFields(node, st);
                if (action.isEmpty()) {
                    NodeResult result = NodeResult.fail(0, method + " (팝업 URL 없음)", "팝업 URL이 비어 있습니다.");
                    recorder.record(node, st.seq++, result, NodeExecutionStatus.FAILED, 0);
                    return Outcome.failed("노드 실패: " + node.name() + " — 팝업 URL이 비어 있습니다.");
                }
                st.pendingNodeId = id;
                st.pendingFormSpec = new PendingForm(id, node.name(), action, method, ff);
                return Outcome.pendingForm(st.pendingFormSpec);
            }

            // wait(콜백 대기) 노드: relay 수신 URL 로 콜백/노티가 올 때까지 중단
            if (et == NodeType.WAIT) {
                st.pendingNodeId = id;
                int timeout = node.waitTimeoutSec() == null || node.waitTimeoutSec() <= 0
                        ? 120 : node.waitTimeoutSec();
                return Outcome.pendingWait(new PendingWait(id, node.name(), timeout,
                        receiveUrl(st.relayBase, st.relayRunId, id)));
            }

            // input(사용자 입력) 노드: 브라우저 모달로 값을 받도록 중단 — confirm 값이 노드 출력이 된다
            if (et == NodeType.INPUT) {
                st.pendingNodeId = id;
                String msg = tokens.resolveTokens(
                        node.waitMsg() == null || node.waitMsg().isBlank() ? "값을 입력하세요" : node.waitMsg(), st.ctx);
                List<PendingInput.Field> fs = new ArrayList<>();
                for (com.flowlink.core.graph.WaitField f
                        : node.waitFields() == null ? List.<com.flowlink.core.graph.WaitField>of() : node.waitFields()) {
                    if (f.key() != null && !f.key().isBlank()) {
                        fs.add(new PendingInput.Field(f.key(), f.label(), f.type()));
                    }
                }
                return Outcome.pendingInput(new PendingInput(id, node.name(), msg, fs));
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

    /** form 노드의 hidden 필드 조립 — Raw(a=1&b=2) 또는 키-값 필드, 값은 바인딩/토큰 해석. */
    private List<PendingForm.Field> formFields(GraphNode node, RunState st) {
        List<PendingForm.Field> ff = new ArrayList<>();
        if (Boolean.TRUE.equals(node.jsonRaw())) {
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
                ff.add(new PendingForm.Field(k, tokens.resolveTokens(eq >= 0 ? pair.substring(eq + 1) : "", st.ctx)));
            }
        } else {
            for (NodeField f : node.fieldsOrEmpty().bodyOrEmpty()) {
                if (f.key() != null && !f.key().isBlank()) {
                    ff.add(new PendingForm.Field(f.key(), resolveFormFieldValue(f, st)));
                }
            }
        }
        return ff;
    }

    /** 폼 필드 값 — 바인딩이면 그 값, 리터럴이면 토큰 해석. */
    private String resolveFormFieldValue(NodeField f, RunState st) {
        if (f.bound() != null) {
            return tokens.stringify(tokens.fieldValue(f, st.ctx));
        }
        return tokens.resolveTokens(f.value() == null ? "" : f.value(), st.ctx);
    }

    /** form 재개 — 팝업 submit 확인(성공) 또는 팝업 차단(실패). 제출 필드는 req: 스코프로 노출. */
    private NodeResult formResumeResult(RunState st, ResumeInput in) {
        PendingForm spec = st.pendingFormSpec;
        StringBuilder req = new StringBuilder();
        Map<String, Object> reqValues = new LinkedHashMap<>();
        if (spec != null) {
            req.append(spec.method()).append(' ').append(spec.action());
            for (PendingForm.Field f : spec.fields()) {
                req.append('\n').append(f.key()).append('=').append(f.value() == null ? "" : f.value());
                reqValues.put(f.key(), f.value());
            }
        }
        if (in != null && in.error() != null && !in.error().isBlank()) {
            return NodeResult.fail(0, req.toString(), in.error());
        }
        if (in == null || !Boolean.TRUE.equals(in.popupOpened())) {
            return NodeResult.fail(0, req.toString(), "팝업이 열리지 않았습니다 — 브라우저의 팝업 허용이 필요합니다.");
        }
        return new NodeResult(true, null, req.toString(),
                "팝업을 열고 form 을 submit 했습니다 — 기다리지 않고 다음 노드로 진행합니다.",
                Map.of(), Map.of(), reqValues, null);
    }

    /** wait 재개 — 수신 콜백 본문을 파싱해 노드 출력으로. 콜백 없이 재개(타임아웃/중단)면 실패. */
    private NodeResult waitResumeResult(GraphNode node, RunState st, ResumeInput in) {
        String recvUrl = receiveUrl(st.relayBase, st.relayRunId, node.id());
        if (in != null && in.callback() != null) {
            ResumeInput.Callback cb = in.callback();
            StringBuilder req = new StringBuilder();
            req.append("콜백 수신 ").append(cb.method() == null ? "" : cb.method()).append(' ')
                    .append(cb.url() != null ? cb.url() : (recvUrl == null ? "" : recvUrl));
            if (cb.headers() != null) {
                cb.headers().forEach((k, v) -> req.append('\n').append(k).append(": ").append(v));
            }
            String body = cb.body() == null ? "" : cb.body();
            Map<String, Object> values = tryParseCallbackBody(body);
            if (recvUrl != null) {
                values.put("url", recvUrl); // 실행 시작 시 시드된 수신 URL 을 완료 후에도 바인딩 가능하게 유지
            }
            return NodeResult.ok(null, req.toString(), body.isEmpty() ? "(빈 본문)" : body, values);
        }
        String err = (in == null || in.error() == null || in.error().isBlank())
                ? "콜백 없이 재개되었습니다." : in.error();
        return NodeResult.fail(0, "(콜백 대기) " + (recvUrl == null ? "" : recvUrl), err);
    }

    /** input 재개 — 모달에서 confirm 한 값(타입 파싱은 브라우저 몫)이 그대로 노드 출력이 된다. */
    private NodeResult inputResumeResult(GraphNode node, ResumeInput in) {
        if (in != null && in.error() != null && !in.error().isBlank()) {
            return NodeResult.fail(0, "(사용자 입력)", in.error());
        }
        Map<String, Object> values = (in == null || in.formValues() == null)
                ? new LinkedHashMap<>() : new LinkedHashMap<>(in.formValues());
        String msg = node.waitMsg() == null ? "" : node.waitMsg();
        return NodeResult.ok(null, "(사용자 입력) " + msg, json.toJson(values), values);
    }

    /**
     * 콜백 본문 파싱(tryParse) — JSON({,[," 시작)이면 JSON 으로, 실패 시 a=1&b=2 형태면
     * form-urlencoded 객체로, 둘 다 아니면 원문 문자열을 body 키로 보존한다.
     */
    private Map<String, Object> tryParseCallbackBody(String body) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (body == null || body.isBlank()) {
            return out;
        }
        String t = body.trim();
        char c = t.charAt(0);
        if (c == '{' || c == '[' || c == '"') {
            try {
                Object v = json.mapper().readValue(t, Object.class);
                if (v instanceof Map<?, ?> m) {
                    m.forEach((k, val) -> out.put(String.valueOf(k), val));
                } else {
                    out.put("body", v == null ? t : v);
                }
                return out;
            } catch (Exception ignored) {
                // JSON 실패 → 아래 form-urlencoded 폴백
            }
        }
        if (t.indexOf('=') >= 0 && t.indexOf('\n') < 0) {
            for (String pair : t.split("&")) {
                if (pair.isEmpty()) {
                    continue;
                }
                int eq = pair.indexOf('=');
                String k = urlDecode(eq >= 0 ? pair.substring(0, eq) : pair);
                String v = urlDecode(eq >= 0 ? pair.substring(eq + 1) : "");
                if (!k.isEmpty()) {
                    putMulti(out, k, v);
                }
            }
            if (!out.isEmpty()) {
                return out;
            }
        }
        out.put("body", body);
        return out;
    }

    /** 중복 키는 리스트로 누적(HTTP parseForm 규약과 동일). */
    private static void putMulti(Map<String, Object> map, String key, String val) {
        Object prev = map.get(key);
        if (prev == null) {
            map.put(key, val);
        } else if (prev instanceof List<?> list) {
            List<Object> next = new ArrayList<>(list);
            next.add(val);
            map.put(key, next);
        } else {
            List<Object> next = new ArrayList<>();
            next.add(prev);
            next.add(val);
            map.put(key, next);
        }
    }

    private static String urlDecode(String s) {
        try {
            return URLDecoder.decode(s, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return s;
        }
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
            // 정상 흐름에선 drive()가 선처리 — 방어적 통과
            case FORM, WAIT, INPUT -> NodeResult.ok(null, "(대기/폼/입력)", "브라우저 협업 노드 — drive 선처리 경로", Map.of());
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
