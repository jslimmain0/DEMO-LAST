package com.flowlink.execution.engine

import com.flowlink.common.json.JsonService
import com.flowlink.core.domain.ExecutionStatus
import com.flowlink.core.domain.NodeExecutionStatus
import com.flowlink.core.graph.FlowGraph
import com.flowlink.core.graph.GraphEdge
import com.flowlink.core.graph.GraphNode
import com.flowlink.core.graph.NodeField
import com.flowlink.core.graph.NodeType
import com.flowlink.core.graph.NodeVar
import com.flowlink.core.graph.WaitField
import com.flowlink.transform.FlowTransform
import com.flowlink.transform.TransformRegistry
import org.springframework.stereotype.Component
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque

/**
 * 워크플로 그래프를 위상정렬 순서로 실행하는 동기 오케스트레이터.
 * 프로토타입 runFlow 의 의미(도달 노드만 실행, IF는 선택 분기만 진행, 첫 실패 시 중단)를 서버에서 재현한다.
 *
 * <p>브라우저 협업이 필요한 노드는 WAITING 으로 일시중단하고 pending 명세를 넘긴다:
 * client 모드 HTTP(브라우저가 대신 호출) · form(팝업으로 폼 제출, submit 즉시 재개) ·
 * wait(relay 수신 URL 로 콜백/노티가 올 때까지 대기 — 타임아웃/중단도 브라우저가 resume 으로 알린다).
 */
@Component
class FlowExecutor(
    private val tokens: TokenResolver,
    private val evaluator: ExpressionEvaluator,
    private val httpExecutor: HttpNodeExecutor,
    private val json: JsonService,
    private val transformRegistry: TransformRegistry,
    private val tcpExecutor: TcpNodeExecutor
) {

    data class Outcome(
        val status: ExecutionStatus,
        val error: String?,
        val pendingClient: PendingClient?,
        val pendingForm: PendingForm?,
        val pendingWait: PendingWait?,
        val pendingInput: PendingInput?
    ) {
        fun isPending(): Boolean =
            pendingClient != null || pendingForm != null || pendingWait != null || pendingInput != null

        companion object {
            fun succeeded(): Outcome =
                Outcome(ExecutionStatus.SUCCEEDED, null, null, null, null, null)

            fun failed(error: String?): Outcome =
                Outcome(ExecutionStatus.FAILED, error, null, null, null, null)

            fun pendingClient(pc: PendingClient): Outcome =
                Outcome(ExecutionStatus.WAITING, null, pc, null, null, null)

            fun pendingForm(pf: PendingForm): Outcome =
                Outcome(ExecutionStatus.WAITING, null, null, pf, null, null)

            fun pendingWait(pw: PendingWait): Outcome =
                Outcome(ExecutionStatus.WAITING, null, null, null, pw, null)

            fun pendingInput(pi: PendingInput): Outcome =
                Outcome(ExecutionStatus.WAITING, null, null, null, null, pi)
        }
    }

    /** client 모드 HTTP 노드에서 중단할 때, 브라우저가 대신 호출하도록 넘기는 조립된 요청. */
    data class PendingClient(
        val nodeId: String?, val nodeName: String?, val method: String, val url: String,
        val headers: Map<String, String>, val body: String?, val respType: String
    )

    /** form(팝업) 노드에서 중단할 때, 브라우저가 팝업으로 제출할 폼 명세(값은 해석 완료). */
    data class PendingForm(
        val nodeId: String?, val nodeName: String?, val action: String, val method: String,
        val fields: List<Field>
    ) {
        data class Field(val key: String?, val value: String?)
    }

    /** wait(콜백 대기) 노드에서 중단할 때 넘기는 대기 명세. receiveUrl 은 relay 미연동이면 null. */
    data class PendingWait(val nodeId: String?, val nodeName: String?, val timeoutSec: Int, val receiveUrl: String?)

    /** input(사용자 입력) 노드에서 중단할 때, 브라우저가 모달로 띄울 입력 명세. */
    data class PendingInput(val nodeId: String?, val nodeName: String?, val message: String, val fields: List<Field>) {
        data class Field(val key: String?, val label: String?, val type: String?)
    }

    /**
     * 재개 입력 — ExecutionService 가 dto ResumeRequest 를 이 형태로 옮겨 넘긴다.
     * client HTTP 는 httpStatus/body/error, form 은 popupOpened/error, wait 는 callback/error.
     */
    data class ResumeInput(
        val httpStatus: Int?, val body: String?, val error: String?,
        val popupOpened: Boolean?, val callback: Callback?, val formValues: Map<String, Any?>?
    ) {
        data class Callback(val method: String?, val url: String?, val headers: Map<String, String>?, val body: String?)
    }

    /**
     * 재개 가능한 실행 진행 상태(인메모리). 브라우저 협업 노드에서 WAITING 으로 중단했다가
     * {@link #resume} 으로 이어서 실행한다. wait/input/form/client 중단 지점의 이 상태는
     * [snapshot]/[rehydrate] 로 DB(execution_suspension, AES-GCM 암호화)에 내구화돼 서버 재시작을 견딘다(SaaS P2).
     * 워커 풀은 단일 인스턴스 스코프(수평 확장=공유 큐는 범위 밖).
     */
    class RunState internal constructor(
        internal val edges: List<GraphEdge>,
        internal val byId: Map<String, GraphNode>,
        internal val order: List<String>,
        internal val active: MutableSet<String>,
        internal val ctx: ExecutionContext,
        // 콜백 수신 URL 조립용 — 브라우저가 실행 직전에 만든 relay 실행ID/주소 (없으면 null)
        internal val relayBase: String?,
        internal val relayRunId: String?
    ) {
        internal var index: Int = 0
        internal var seq: Int = 0
        internal var pendingNodeId: String? = null // 중단(재개 대기) 중인 노드 — client HTTP / form / wait
        internal var pendingFormSpec: PendingForm? = null // form 중단 시 해석 완료된 폼 명세(재개 로그·요청값용)

        fun context(): ExecutionContext = ctx
    }

    fun newRun(graph: FlowGraph, ctx: ExecutionContext): RunState = newRun(graph, ctx, null, null)

    fun newRun(graph: FlowGraph, ctx: ExecutionContext, relayBase: String?, relayRunId: String?): RunState {
        // 메모/영역 박스(주석)는 실행과 무관 — 위상정렬/활성화/기록에서 제외(연결도 없어 UNKNOWN 실패를 만들지 않게)
        val nodes = graph.nodesOrEmpty().filter { !it.nodeType().isAnnotation() }
        val edges = graph.edgesOrEmpty()
        val byId = HashMap<String, GraphNode>()
        nodes.forEach { n -> byId[n.id!!] = n }
        val order = topoOrder(nodes, edges)
        val active = initialActive(nodes, edges)
        return RunState(edges, byId, order, active, ctx, relayBase, relayRunId)
    }

    /**
     * 재개 상태의 내구 영속용 스냅샷 — 그래프는 제외(graphJson 재파싱으로 재구성),
     * 변이 상태(active/ctx/index/seq/pending)만 담는다.
     */
    fun snapshot(st: RunState): RunStateSnapshot = RunStateSnapshot(
        st.active.toList(), st.ctx.snapshotValues(), st.ctx.snapshotSeeds(),
        st.index, st.seq, st.pendingNodeId, st.pendingFormSpec, st.relayBase, st.relayRunId
    )

    /** 스냅샷 + 원본 그래프로 RunState 를 되살린다(서버 재시작 후 콜백/재개용). */
    fun rehydrate(graph: FlowGraph, snap: RunStateSnapshot): RunState {
        val ctx = ExecutionContext()
        ctx.restore(snap.ctxValues, snap.ctxSeeds)
        val st = newRun(graph, ctx, snap.relayBase, snap.relayRunId)
        st.active.clear()
        st.active.addAll(snap.activeIds)
        st.index = snap.index
        st.seq = snap.seq
        st.pendingNodeId = snap.pendingNodeId
        st.pendingFormSpec = snap.pendingForm
        return st
    }

    /** 처음부터 실행한다(편의 오버로드 — 재개가 필요 없는 호출/테스트용). */
    fun execute(graph: FlowGraph, ctx: ExecutionContext, recorder: NodeRecorder): Outcome =
        drive(newRun(graph, ctx), recorder)

    fun execute(state: RunState, recorder: NodeRecorder): Outcome = drive(state, recorder)

    /**
     * 중단 지점 노드에 재개 입력을 적재하고 이어서 실행한다.
     * form → 팝업 submit 확인 후 즉시 진행, wait → 수신 콜백 본문이 노드 출력이 되고,
     * client HTTP → 브라우저가 돌려준 응답이 결과가 된다.
     */
    fun resume(st: RunState, input: ResumeInput?, durationMs: Long, recorder: NodeRecorder): Outcome {
        val pid = st.pendingNodeId ?: return drive(st, recorder) // 중단 상태가 아니면 방어적으로 계속 진행
        val node = st.byId[pid]!!
        val et = node.effectiveType()
        val result: NodeResult = if (et == NodeType.FORM) {
            formResumeResult(st, input)
        } else if (et == NodeType.WAIT) {
            waitResumeResult(node, st, input)
        } else if (et == NodeType.INPUT) {
            inputResumeResult(node, input)
        } else {
            val req = httpExecutor.build(node, st.ctx)
            httpExecutor.clientResult(node, req,
                if (input == null || input.httpStatus == null) 0 else input.httpStatus,
                if (input == null) null else input.body,
                if (input == null) null else input.error)
        }
        st.pendingFormSpec = null

        val nid = node.id!!
        st.ctx.putOutput(nid, result.value)
        if (result.reqValues != null) {
            st.ctx.putRequest(nid, result.reqValues)
        }
        recorder.record(node, st.seq++, result,
            if (result.ok) NodeExecutionStatus.SUCCEEDED else NodeExecutionStatus.FAILED, durationMs)
        st.pendingNodeId = null

        if (!result.ok) {
            return Outcome.failed("노드 실패: " + node.name + " — " + truncate(result.responseText))
        }
        activateDownstream(st, node, null)
        st.index++ // 중단을 유발한 노드는 처리 완료 → 다음 노드부터
        return drive(st, recorder)
    }

    private fun drive(st: RunState, recorder: NodeRecorder): Outcome {
        while (st.index < st.order.size) {
            val id = st.order[st.index]
            val node = st.byId[id]
            if (node == null) {
                st.index++
                continue
            }
            if (!st.active.contains(id)) {
                recorder.record(node, st.seq++, NodeResult.ok(null, "(미실행)", "분기 미선택으로 건너뜀", null),
                    NodeExecutionStatus.SKIPPED, 0)
                st.index++
                continue
            }

            val et = node.effectiveType()

            // form(팝업) 노드: 브라우저가 팝업으로 form 을 제출하도록 중단 — submit 후 즉시 재개(기다리지 않음)
            if (et == NodeType.FORM) {
                val method = if (node.formMethod == null) "POST" else node.formMethod.uppercase()
                val action = tokens.resolveTokens(node.formAction ?: "", st.ctx).trim()
                val ff = formFields(node, st)
                if (action.isEmpty()) {
                    val result = NodeResult.fail(0, "$method (팝업 URL 없음)", "팝업 URL이 비어 있습니다.")
                    recorder.record(node, st.seq++, result, NodeExecutionStatus.FAILED, 0)
                    return Outcome.failed("노드 실패: " + node.name + " — 팝업 URL이 비어 있습니다.")
                }
                st.pendingNodeId = id
                val spec = PendingForm(id, node.name, action, method, ff)
                st.pendingFormSpec = spec
                return Outcome.pendingForm(spec)
            }

            // wait(콜백 대기) 노드: relay 수신 URL 로 콜백/노티가 올 때까지 중단
            if (et == NodeType.WAIT) {
                st.pendingNodeId = id
                val timeout = if (node.waitTimeoutSec == null || node.waitTimeoutSec <= 0) 120 else node.waitTimeoutSec
                return Outcome.pendingWait(PendingWait(id, node.name, timeout,
                    receiveUrl(st.relayBase, st.relayRunId, id)))
            }

            // input(사용자 입력) 노드: 브라우저 모달로 값을 받도록 중단 — confirm 값이 노드 출력이 된다
            if (et == NodeType.INPUT) {
                st.pendingNodeId = id
                val msg = tokens.resolveTokens(
                    if (node.waitMsg == null || node.waitMsg.isBlank()) "값을 입력하세요" else node.waitMsg, st.ctx)
                val fs = ArrayList<PendingInput.Field>()
                for (f in node.waitFields ?: emptyList<WaitField>()) {
                    if (f.key != null && !f.key.isBlank()) {
                        fs.add(PendingInput.Field(f.key, f.label, f.type))
                    }
                }
                return Outcome.pendingInput(PendingInput(id, node.name, msg, fs))
            }

            // client 모드 HTTP 노드: 서버가 호출하지 않고 브라우저로 위임 → WAITING 으로 중단
            if (et == NodeType.HTTP && isClientMode(node)) {
                val req = httpExecutor.build(node, st.ctx)
                st.pendingNodeId = id
                val pc = PendingClient(id, node.name, req.method, req.url,
                    req.headers, req.body, node.respType ?: "json")
                return Outcome.pendingClient(pc)
            }

            val t0 = System.nanoTime()
            val result: NodeResult = try {
                processNode(node, st.ctx)
            } catch (e: Exception) {
                NodeResult.fail(0, "", "⚠ " + (e.message ?: e.toString()))
            }
            val durationMs = (System.nanoTime() - t0) / 1_000_000

            st.ctx.putOutput(id, result.value)
            if (result.reqValues != null) {
                st.ctx.putRequest(id, result.reqValues)
            }

            recorder.record(node, st.seq++, result,
                if (result.ok) NodeExecutionStatus.SUCCEEDED else NodeExecutionStatus.FAILED, durationMs)

            if (!result.ok) {
                return Outcome.failed("노드 실패: " + node.name + " — " + truncate(result.responseText))
            }

            // 다운스트림 활성화: IF/SWITCH 는 선택 분기(트랙)만
            val nt = node.nodeType()
            val taken = if (nt == NodeType.IF || nt == NodeType.SWITCH) result.branch else null
            activateDownstream(st, node, taken)
            st.index++
        }
        return Outcome.succeeded()
    }

    private fun activateDownstream(st: RunState, node: GraphNode, takenBranch: String?) {
        for (e in st.edges) {
            if (node.id != e.from) {
                continue
            }
            if (takenBranch != null && takenBranch != e.fromPortOrDefault()) {
                continue
            }
            e.to?.let { st.active.add(it) }
        }
    }

    /** form 노드의 hidden 필드 조립 — Raw(a=1&b=2) 또는 키-값 필드, 값은 바인딩/토큰 해석. */
    private fun formFields(node: GraphNode, st: RunState): List<PendingForm.Field> {
        val ff = ArrayList<PendingForm.Field>()
        if (node.jsonRaw == true) {
            val raw = node.rawBody ?: ""
            for (pair in raw.split("&")) {
                if (pair.isBlank()) {
                    continue
                }
                val eq = pair.indexOf('=')
                val k = (if (eq >= 0) pair.substring(0, eq) else pair).trim()
                if (k.isEmpty()) {
                    continue
                }
                ff.add(PendingForm.Field(k, tokens.resolveTokens(if (eq >= 0) pair.substring(eq + 1) else "", st.ctx)))
            }
        } else {
            for (f in node.fieldsOrEmpty().bodyOrEmpty()) {
                if (f.key != null && !f.key.isBlank()) {
                    ff.add(PendingForm.Field(f.key, resolveFormFieldValue(f, st)))
                }
            }
        }
        return ff
    }

    /** 폼 필드 값 — 바인딩이면 그 값, 리터럴이면 토큰 해석. */
    private fun resolveFormFieldValue(f: NodeField, st: RunState): String {
        if (f.bound != null) {
            return tokens.stringify(tokens.fieldValue(f, st.ctx))
        }
        return tokens.resolveTokens(f.value ?: "", st.ctx)
    }

    /** form 재개 — 팝업 submit 확인(성공) 또는 팝업 차단(실패). 제출 필드는 req: 스코프로 노출. */
    private fun formResumeResult(st: RunState, input: ResumeInput?): NodeResult {
        val spec = st.pendingFormSpec
        val req = StringBuilder()
        val reqValues = LinkedHashMap<String, Any?>()
        if (spec != null) {
            req.append(spec.method).append(' ').append(spec.action)
            for (f in spec.fields) {
                req.append('\n').append(f.key).append('=').append(f.value ?: "")
                reqValues[f.key!!] = f.value
            }
        }
        if (input != null && input.error != null && !input.error.isBlank()) {
            return NodeResult.fail(0, req.toString(), input.error)
        }
        if (input == null || input.popupOpened != true) {
            return NodeResult.fail(0, req.toString(), "팝업이 열리지 않았습니다 — 브라우저의 팝업 허용이 필요합니다.")
        }
        return NodeResult(true, null, req.toString(),
            "팝업을 열고 form 을 submit 했습니다 — 기다리지 않고 다음 노드로 진행합니다.",
            emptyMap<String, Any?>(), emptyMap<String, Any?>(), reqValues, null)
    }

    /** wait 재개 — 수신 콜백 본문을 파싱해 노드 출력으로. 콜백 없이 재개(타임아웃/중단)면 실패. */
    private fun waitResumeResult(node: GraphNode, st: RunState, input: ResumeInput?): NodeResult {
        val recvUrl = receiveUrl(st.relayBase, st.relayRunId, node.id)
        if (input != null && input.callback != null) {
            val cb = input.callback
            val req = StringBuilder()
            req.append("콜백 수신 ").append(cb.method ?: "").append(' ')
                .append(if (cb.url != null) cb.url else (recvUrl ?: ""))
            if (cb.headers != null) {
                cb.headers.forEach { (k, v) -> req.append('\n').append(k).append(": ").append(v) }
            }
            val body = cb.body ?: ""
            val values = tryParseCallbackBody(body)
            if (recvUrl != null) {
                values["url"] = recvUrl // 실행 시작 시 시드된 수신 URL 을 완료 후에도 바인딩 가능하게 유지
            }
            return NodeResult.ok(null, req.toString(), if (body.isEmpty()) "(빈 본문)" else body, values)
        }
        val err = if (input == null || input.error == null || input.error.isBlank())
            "콜백 없이 재개되었습니다." else input.error
        return NodeResult.fail(0, "(콜백 대기) " + (recvUrl ?: ""), err)
    }

    /** input 재개 — 모달에서 confirm 한 값(타입 파싱은 브라우저 몫)이 그대로 노드 출력이 된다. */
    private fun inputResumeResult(node: GraphNode, input: ResumeInput?): NodeResult {
        if (input != null && input.error != null && !input.error.isBlank()) {
            return NodeResult.fail(0, "(사용자 입력)", input.error)
        }
        val values: Map<String, Any?> = if (input == null || input.formValues == null)
            LinkedHashMap() else LinkedHashMap(input.formValues)
        val msg = node.waitMsg ?: ""
        return NodeResult.ok(null, "(사용자 입력) " + msg, json.toJson(values), values)
    }

    /**
     * 콜백 본문 파싱(tryParse) — JSON({,[," 시작)이면 JSON 으로, 실패 시 a=1&b=2 형태면
     * form-urlencoded 객체로, 둘 다 아니면 원문 문자열을 body 키로 보존한다.
     */
    private fun tryParseCallbackBody(body: String?): MutableMap<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        if (body == null || body.isBlank()) {
            return out
        }
        val t = body.trim()
        val c = t[0]
        if (c == '{' || c == '[' || c == '"') {
            try {
                val v = json.mapper().readValue(t, Any::class.java)
                if (v is Map<*, *>) {
                    v.forEach { (k, value) -> out[k.toString()] = value }
                } else {
                    out["body"] = v ?: t
                }
                return out
            } catch (ignored: Exception) {
                // JSON 실패 → 아래 form-urlencoded 폴백
            }
        }
        if (t.indexOf('=') >= 0 && t.indexOf('\n') < 0) {
            for (pair in t.split("&")) {
                if (pair.isEmpty()) {
                    continue
                }
                val eq = pair.indexOf('=')
                val k = urlDecode(if (eq >= 0) pair.substring(0, eq) else pair)
                val value = urlDecode(if (eq >= 0) pair.substring(eq + 1) else "")
                if (k.isNotEmpty()) {
                    putMulti(out, k, value)
                }
            }
            if (out.isNotEmpty()) {
                return out
            }
        }
        out["body"] = body
        return out
    }

    /**
     * 단일 노드 독립 실행 — 새(빈) 컨텍스트로 그 노드 하나만 처리한다. 상류 바인딩({{ x@노드 }})은
     * 값이 없어 null 로 풀린다(노드 자체 로직·리터럴 검증용). 브라우저 협업 노드(대기/폼/입력/client HTTP)는
     * 콜백/모달이 필요해 단독 실행을 지원하지 않는다.
     */
    fun runSingleNode(node: GraphNode): NodeResult {
        val et = node.effectiveType()
        if (et == NodeType.FORM || et == NodeType.WAIT || et == NodeType.INPUT ||
            (et == NodeType.HTTP && isClientMode(node))) {
            return NodeResult.fail(0, "", "단독 실행 미지원 노드(대기/폼/입력/클라이언트 모드) — 전체 실행을 쓰세요.")
        }
        return try {
            processNode(node, ExecutionContext())
        } catch (e: Exception) {
            NodeResult.fail(0, "", "⚠ " + (e.message ?: e.toString()))
        }
    }

    private fun processNode(node: GraphNode, ctx: ExecutionContext): NodeResult =
        when (node.nodeType()) {
            NodeType.START -> NodeResult.ok(null, "(시작)", "플로우 시작", emptyMap<String, Any?>())
            NodeType.END -> NodeResult.ok(null, "(끝)", "플로우 종료", emptyMap<String, Any?>())
            NodeType.SET -> setNode(node, ctx)
            NodeType.IF -> ifNode(node, ctx)
            NodeType.SWITCH -> switchNode(node)
            NodeType.ASSERT -> assertNode(node, ctx)
            NodeType.HTTP -> httpExecutor.execute(node, ctx)
            NodeType.TRANSFORM -> transformNode(node, ctx)
            NodeType.TCP -> tcpExecutor.execute(node, ctx)
            // 정상 흐름에선 drive()가 선처리 — 방어적 통과
            NodeType.FORM, NodeType.WAIT, NodeType.INPUT ->
                NodeResult.ok(null, "(대기/폼/입력)", "브라우저 협업 노드 — drive 선처리 경로", emptyMap<String, Any?>())
            // 주석 노드는 newRun 에서 걸러져 여기 오지 않는다 — 방어적 통과
            NodeType.NOTE, NodeType.GROUP ->
                NodeResult.ok(null, "(주석)", "메모/영역 박스 — 실행 제외", emptyMap<String, Any?>())
            NodeType.UNKNOWN -> NodeResult.fail(0, "", "지원하지 않는 노드 타입: " + node.type)
        }

    private fun setNode(node: GraphNode, ctx: ExecutionContext): NodeResult {
        val value = LinkedHashMap<String, Any?>()
        val masked = LinkedHashMap<String, Any?>()
        val vars = node.vars ?: emptyList<NodeVar>()
        for (v in vars) {
            if (v.key == null || v.key.isBlank()) {
                continue
            }
            // 리터럴 값도 {{토큰}} 해석 — 인라인 데이터 삽입(텍스트+토큰 혼합)을 SET 에서도 지원.
            // 정확히 토큰 하나면 원형(숫자/불리언/객체) 보존(구 bound 와 동일 의미), 혼합이면 문자열 치환,
            // 토큰이 없으면 원문 그대로(무회귀).
            val resolved: Any? = if (v.bound != null) {
                tokens.resolveBinding(v.bound, ctx)
            } else if (v.value != null && v.value.contains("{{")) {
                tokens.resolveLiteral(v.value, ctx)
            } else {
                v.value
            }
            value[v.key] = resolved
            masked[v.key] = if (v.secret) "••••••" else resolved
        }
        return NodeResult(true, null, "(변수 저장)", json.toJson(masked), value, masked, null, null)
    }

    /**
     * 경로 스위치(선로 전환기) — 조건 평가 없이 에디터에서 젖혀둔 트랙(switchActive)으로만 흐른다.
     * IF 와 동일한 분기 메커니즘(branch → 엣지 fromPort 매칭)이라 나머지 트랙 하류는 SKIPPED.
     */
    private fun switchNode(node: GraphNode): NodeResult {
        val branch = if (node.switchActive.isNullOrBlank()) "1" else node.switchActive
        val value = LinkedHashMap<String, Any?>()
        value["branch"] = branch
        return NodeResult.ok(null, "switch → 트랙 $branch", json.toJson(value), value).withBranch(branch)
    }

    private fun ifNode(node: GraphNode, ctx: ExecutionContext): NodeResult {
        val result = evaluator.evaluateBoolean(node.condition, ctx)
        val branch = if (result) "true" else "false"
        val value = LinkedHashMap<String, Any?>()
        value["result"] = result
        value["branch"] = branch
        return NodeResult.ok(null, "if ( " + (node.condition ?: "") + " )",
            json.toJson(value), value).withBranch(branch)
    }

    /**
     * 검증(assert) 노드 — IF 와 같은 조건 문법이지만 분기 대신 <b>거짓이면 노드 실패</b>(=실행 FAILED).
     * 테스트 시나리오의 assert 판정용. 빈 조건은 실수로 항상 통과하는 것을 막기 위해 실패 처리한다.
     */
    private fun assertNode(node: GraphNode, ctx: ExecutionContext): NodeResult {
        val cond = (node.condition ?: "").trim()
        val reqText = "assert ( $cond )"
        if (cond.isEmpty()) {
            return NodeResult.fail(0, reqText, "⚠ 검증 실패: 조건이 비어 있습니다.")
        }
        val passed = evaluator.evaluateBoolean(cond, ctx)
        if (!passed) {
            return NodeResult.fail(0, reqText, "⚠ 검증 실패: 조건이 거짓입니다 — $cond")
        }
        val value = mapOf<String, Any?>("result" to true)
        return NodeResult.ok(null, reqText, "검증 통과", value)
    }

    private fun transformNode(node: GraphNode, ctx: ExecutionContext): NodeResult {
        val transform = transformRegistry.get(node.transformId ?: "").orElse(null)
            ?: return NodeResult.fail(0, "transform " + node.transformId, "알 수 없는 변환: " + node.transformId)

        // 선언된 입력 포트별로 fields.body 의 동일 key 행을 찾아 값(바인딩/리터럴)을 해석
        val byKey = HashMap<String, NodeField>()
        for (f in node.fieldsOrEmpty().bodyOrEmpty()) {
            if (f.key != null && !f.key.isBlank()) {
                byKey[f.key] = f
            }
        }
        val inputs = LinkedHashMap<String, String>()
        for (spec in transform.inputs()) {
            val f = byKey[spec.key]
            inputs[spec.key] = if (f == null) "" else tokens.stringify(tokens.fieldValue(f, ctx))
        }

        val config = node.config ?: emptyMap()
        val out: Map<String, String>? = try {
            transform.apply(inputs, config)
        } catch (e: Exception) {
            return NodeResult.fail(0, "transform " + transform.id(),
                "변환 실패: " + (e.message ?: e.toString()))
        }
        val value = LinkedHashMap<String, Any?>(out ?: emptyMap())
        return NodeResult.ok(null, "transform " + transform.id() + " in=" + inputs, json.toJson(value), value)
    }

    // --- 위상정렬 (Kahn) ---
    private fun topoOrder(nodes: List<GraphNode>, edges: List<GraphEdge>): List<String> {
        val indeg = HashMap<String, Int>()
        val adj = HashMap<String, MutableList<String>>()
        nodes.forEach { n ->
            indeg[n.id!!] = 0
            adj[n.id!!] = ArrayList()
        }
        for (e in edges) {
            val from = e.from
            val to = e.to
            if (from != null && to != null && adj.containsKey(from) && indeg.containsKey(to)) {
                adj[from]!!.add(to)
                indeg.merge(to, 1) { a, b -> a + b }
            }
        }
        val queue = ArrayDeque<String>()
        nodes.forEach { n ->
            if (indeg[n.id!!] == 0) {
                queue.add(n.id!!)
            }
        }
        val order = ArrayList<String>()
        val seen = HashSet<String>()
        while (queue.isNotEmpty()) {
            val id = queue.poll()
            if (!seen.add(id)) {
                continue
            }
            order.add(id)
            for (t in adj[id]!!) {
                indeg.merge(t, -1) { a, b -> a + b }
                if (indeg[t]!! <= 0) {
                    queue.add(t)
                }
            }
        }
        // 사이클 등으로 남은 노드는 뒤에 덧붙임(프로토타입과 동일)
        nodes.forEach { n ->
            if (!seen.contains(n.id!!)) {
                order.add(n.id!!)
            }
        }
        return order
    }

    /**
     * 실행 시작점 — **START 노드에서 시작해 연결(엣지)을 따라 흐른다.** START 에서 도달하지 못하는 노드는
     * 실행하지 않는다(활성화 안 돼 SKIPPED). 이전에는 "진입차수 0" 인 노드를 전부 시작점으로 삼아,
     * START 에 연결 안 된 떠 있는 노드가 멋대로 실행되던 버그가 있었다.
     * START 가 하나도 없는 (구/손편집) 그래프는 레거시 폴백으로 진입차수 0 을 시작점으로 쓴다.
     */
    private fun initialActive(nodes: List<GraphNode>, edges: List<GraphEdge>): MutableSet<String> {
        val starts = nodes.filter { it.nodeType() == NodeType.START }.mapNotNull { it.id }
        if (starts.isNotEmpty()) return HashSet(starts)

        val indeg = HashMap<String, Int>()
        nodes.forEach { n -> indeg[n.id!!] = 0 }
        for (e in edges) {
            val to = e.to
            if (to != null && indeg.containsKey(to)) {
                indeg.merge(to, 1) { a, b -> a + b }
            }
        }
        val active = HashSet<String>()
        nodes.forEach { n ->
            if (indeg[n.id!!] == 0) {
                active.add(n.id!!)
            }
        }
        return active
    }

    companion object {
        /**
         * wait 노드의 콜백 수신 URL — {relayBase}/relay/{execId}/cb/{nodeId}.
         * 백엔드가 이 경로로 콜백을 직접 받아 실행을 재개한다(RelayController). base 미설정이면 null.
         * (relayRunId 파라미터의 값은 실행ID 문자열 — 실행 시작 시 확정된다)
         */
        @JvmStatic
        fun receiveUrl(relayBase: String?, relayRunId: String?, nodeId: String?): String? {
            if (relayBase == null || relayBase.isBlank() || relayRunId == null || relayRunId.isBlank()) {
                return null
            }
            val base = if (relayBase.endsWith("/")) relayBase.substring(0, relayBase.length - 1) else relayBase
            return base + "/relay/" + relayRunId + "/cb/" + nodeId
        }

        private fun isClientMode(node: GraphNode): Boolean = "client".equals(node.reqMode, ignoreCase = true)

        /** 중복 키는 리스트로 누적(HTTP parseForm 규약과 동일). */
        private fun putMulti(map: MutableMap<String, Any?>, key: String, value: String?) {
            val prev = map[key]
            if (prev == null) {
                map[key] = value
            } else if (prev is List<*>) {
                val next = ArrayList<Any?>(prev)
                next.add(value)
                map[key] = next
            } else {
                val next = ArrayList<Any?>()
                next.add(prev)
                next.add(value)
                map[key] = next
            }
        }

        private fun urlDecode(s: String): String =
            try {
                URLDecoder.decode(s, StandardCharsets.UTF_8)
            } catch (e: Exception) {
                s
            }

        private fun truncate(s: String?): String {
            if (s == null) {
                return ""
            }
            return if (s.length > 300) s.substring(0, 300) + "…" else s
        }
    }
}
