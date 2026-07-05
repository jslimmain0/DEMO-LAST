package com.flowlink.execution

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Execution
import com.flowlink.core.domain.ExecutionStatus
import com.flowlink.core.domain.NodeExecution
import com.flowlink.core.domain.TriggerType
import com.flowlink.core.graph.NodeType
import com.flowlink.core.repository.ExecutionRepository
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FlowVersionRepository
import com.flowlink.core.repository.NodeExecutionRepository
import com.flowlink.execution.config.ExecutionProperties
import com.flowlink.execution.dto.ExecutionDetail
import com.flowlink.execution.dto.ExecutionSummary
import com.flowlink.execution.dto.NodeExecutionView
import com.flowlink.execution.dto.PendingClientRequest
import com.flowlink.execution.dto.PendingFormRequest
import com.flowlink.execution.dto.PendingInputRequest
import com.flowlink.execution.dto.PendingWaitRequest
import com.flowlink.execution.dto.ResumeRequest
import com.flowlink.execution.dto.RunRequest
import com.flowlink.execution.engine.ExecutionContext
import com.flowlink.execution.engine.FlowExecutor
import com.flowlink.execution.engine.NodeRecorder
import org.springframework.data.domain.PageRequest
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.regex.Pattern

/**
 * 워크플로 실행의 진입점 + 영속화 경계.
 *
 * 주의(Phase 1): 동기 실행이다 — 호출 스레드가 모든 노드(외부 HTTP 포함)를 끝까지 수행한다.
 * 운영용 비동기 큐/워커(at-least-once)·내구성 실행은 후속 Phase. DB 트랜잭션을 외부 호출 동안
 * 길게 잡지 않도록, 노드별 결과는 짧은 독립 트랜잭션으로 즉시 저장한다(run() 은 비트랜잭션).
 */
@Service
class ExecutionService(
    private val flowRepo: FlowRepository,
    private val versionRepo: FlowVersionRepository,
    private val executionRepo: ExecutionRepository,
    private val nodeExecRepo: NodeExecutionRepository,
    private val flowExecutor: FlowExecutor,
    private val json: JsonService,
    private val props: ExecutionProperties
) {
    private val mapper: ObjectMapper = json.mapper()

    /**
     * 브라우저 협업 노드(client HTTP / form / wait)에서 WAITING 으로 중단된 실행의 재개 상태(인메모리).
     * 단일 인스턴스/세션 한정 — 서버 재시작 시 소실되며 내구성 보관은 후속 Phase.
     */
    private val suspensions: MutableMap<UUID, Suspended> = ConcurrentHashMap()

    private data class Suspended(val state: FlowExecutor.RunState, val tenant: String)

    fun run(flowId: UUID, req: RunRequest?): ExecutionDetail {
        val tenant = TenantContext.getTenantId()
        val flow = flowRepo.findByIdAndTenantId(flowId, tenant)
            .orElseThrow { NotFoundException.of("Flow", flowId) }

        val versionNo = req?.versionNo ?: flow.currentVersion
        val version = versionRepo.findByFlowIdAndVersionNo(flowId, versionNo)
            .orElseThrow { NotFoundException.of("FlowVersion", "$flowId/v$versionNo") }

        val graph = json.parseGraph(version.graphJson)
        if (graph.nodesOrEmpty().size > props.maxNodesPerRun) {
            throw BadRequestException("노드 수가 상한을 초과했습니다.")
        }

        val inputJson: String? = req?.input?.let { if (it.isNull) null else json.toJson(it) }

        val execution = Execution.start(
            tenant, flowId, version.id, TriggerType.MANUAL, currentUser(), inputJson
        )
        executionRepo.save(execution)
        val execId = execution.id

        val ctx = ExecutionContext()
        seedInput(ctx, req)

        // wait(콜백 대기) 노드 수신 URL 시드 — 실행 시작 시점에 모든 wait 노드의 url 출력을 미리 확정해
        // {{ url@노드ID }} 가 wait 보다 앞의 노드(returnUrl/notiUrl)에서도 해석되게 한다.
        // putSeed: 명시 스코프/바인딩에만 보임 — bare {{ url }} 의 nearest-upstream 해석을 오염시키지 않는다.
        val relayRunId = sanitizeRelayRunId(req?.relayRunId)
        val relayBase = sanitizeRelayBase(req?.relayBase)
        if (relayRunId != null && relayBase != null) {
            for (n in graph.nodesOrEmpty()) {
                if (n.effectiveType() == NodeType.WAIT) {
                    ctx.putSeed(n.id!!, mapOf("url" to FlowExecutor.receiveUrl(relayBase, relayRunId, n.id)))
                }
            }
        }

        val state = flowExecutor.newRun(graph, ctx, relayBase, relayRunId)

        val outcome: FlowExecutor.Outcome
        try {
            outcome = flowExecutor.execute(state, recorder(execId))
        } catch (e: Exception) {
            execution.markFailed("실행 중 오류: " + msg(e))
            executionRepo.save(execution)
            return detail(execution, null, null, null, null)
        }
        applyStatus(execution, outcome)
        rememberIfPending(execId, outcome, state, tenant)
        executionRepo.save(execution)
        return detail(execution, outcome.pendingClient, outcome.pendingForm, outcome.pendingWait, outcome.pendingInput)
    }

    /**
     * 중단된 실행(client HTTP / form / wait)을, 브라우저가 돌려준 입력으로 이어서 실행한다.
     * 또 다른 중단 지점을 만나면 다시 WAITING + pending 을 돌려준다(루프).
     */
    fun resume(executionId: UUID, req: ResumeRequest?): ExecutionDetail {
        val tenant = TenantContext.getTenantId()
        val suspended = suspensions[executionId]
        if (suspended == null || suspended.tenant != tenant) {
            // 멱등: 이미 재개/완료됐거나 대기 상태가 아니면 에러 대신 현재 상태를 반환.
            val existing = executionRepo.findByIdAndTenantId(executionId, tenant)
                .orElseThrow { NotFoundException.of("Execution", executionId) }
            return detail(existing, null, null, null, null)
        }
        return doResume(executionId, suspended, req)
    }

    /** 재개 실행 + 상태반영 + 영속화 공통 경로. */
    private fun doResume(executionId: UUID, suspended: Suspended, req: ResumeRequest?): ExecutionDetail {
        val execution = executionRepo.findByIdAndTenantId(executionId, TenantContext.getTenantId())
            .orElseThrow { NotFoundException.of("Execution", executionId) }
        val outcome: FlowExecutor.Outcome
        try {
            outcome = flowExecutor.resume(
                suspended.state, toResumeInput(req),
                req?.durationMs ?: 0L,
                recorder(executionId)
            )
        } catch (e: Exception) {
            suspensions.remove(executionId) // 예외 경로에서도 보관소 정리(누수 방지)
            execution.markFailed("재개 중 오류: " + msg(e))
            executionRepo.save(execution)
            return detail(execution, null, null, null, null)
        }
        // 사용자 중단(⏹)은 실패가 아니라 취소로 마감한다.
        if (req != null && req.aborted == true && outcome.status == ExecutionStatus.FAILED) {
            execution.markCancelled(outcome.error)
        } else {
            applyStatus(execution, outcome)
        }
        rememberIfPending(executionId, outcome, suspended.state, suspended.tenant)
        executionRepo.save(execution)
        return detail(execution, outcome.pendingClient, outcome.pendingForm, outcome.pendingWait, outcome.pendingInput)
    }

    @Transactional(readOnly = true)
    fun get(executionId: UUID): ExecutionDetail {
        val e = executionRepo.findByIdAndTenantId(executionId, TenantContext.getTenantId())
            .orElseThrow { NotFoundException.of("Execution", executionId) }
        return detail(e, null, null, null, null)
    }

    @Transactional(readOnly = true)
    fun listForFlow(flowId: UUID, limit: Int): List<ExecutionSummary> {
        val execs = executionRepo.findByFlowIdOrderByStartedAtDesc(flowId, PageRequest.of(0, clamp(limit)))
        return withFlowNames(execs)
    }

    @Transactional(readOnly = true)
    fun listRecent(limit: Int): List<ExecutionSummary> {
        val execs = executionRepo.findByTenantIdOrderByStartedAtDesc(TenantContext.getTenantId(), PageRequest.of(0, clamp(limit)))
        return withFlowNames(execs)
    }

    /** 실행 목록에 워크플로 이름을 채운다(삭제/보관된 플로우도 이름 조회 — UUID 노출 방지). */
    private fun withFlowNames(execs: List<Execution>): List<ExecutionSummary> {
        val ids = execs.map { it.flowId }.toSet()
        val names = HashMap<UUID, String>()
        flowRepo.findAllById(ids).forEach { names[it.id] = it.name }
        return execs.map { ExecutionSummary.from(it, names[it.flowId]) }
    }

    // --- 내부 ---

    /**
     * 노드별 결과를 짧은 독립 트랜잭션으로 즉시 저장하는 콜백. run()/resume() 이 공유한다.
     * redaction deny-by-default: HTTP 노드의 요청/응답 본문(토큰·시크릿 섞일 수 있음)은
     * capture 가 켜진 경우에만 저장하고, 제어 노드(start/if/set 등)의 무해한 표시는 그대로 둔다.
     */
    private fun recorder(execId: UUID): NodeRecorder {
        val captureBodies = props.capture.requestResponseBodies
        return NodeRecorder { node, seq, result, status, durationMs ->
            val ne = NodeExecution.of(execId, node.id!!, node.name, node.type, seq)
            val outputJson = if (result.storedValue != null) json.toJson(result.storedValue) else null
            val redact = !captureBodies && node.nodeType() == NodeType.HTTP
            val requestText = if (redact) "(redacted — capture 비활성)" else result.requestText
            val responseText = if (redact) "(redacted — capture 비활성)" else result.responseText
            ne.complete(
                status, result.ok, result.httpStatus,
                requestText, responseText, outputJson, durationMs
            )
            nodeExecRepo.save(ne)
        }
    }

    private fun applyStatus(execution: Execution, outcome: FlowExecutor.Outcome) {
        when (outcome.status) {
            ExecutionStatus.SUCCEEDED -> execution.markSucceeded()
            ExecutionStatus.WAITING -> execution.markWaiting()
            ExecutionStatus.FAILED -> execution.markFailed(outcome.error)
            else -> execution.markFailed("알 수 없는 실행 결과")
        }
    }

    /** 중단(pending)되면 재개 상태를 보관하고, 그 외(완료/실패)면 비운다. */
    private fun rememberIfPending(
        execId: UUID, outcome: FlowExecutor.Outcome,
        state: FlowExecutor.RunState, tenant: String
    ) {
        if (outcome.status == ExecutionStatus.WAITING && outcome.isPending()) {
            suspensions[execId] = Suspended(state, tenant)
        } else {
            suspensions.remove(execId)
        }
    }

    private fun seedInput(ctx: ExecutionContext, req: RunRequest?) {
        val input = req?.input
        if (input == null || !input.isObject) {
            return
        }
        @Suppress("UNCHECKED_CAST")
        val inputMap = mapper.convertValue(input, Map::class.java) as Map<String, Any?>
        ctx.putOutput("input", inputMap)
    }

    private fun detail(
        e: Execution,
        pending: FlowExecutor.PendingClient?,
        form: FlowExecutor.PendingForm?,
        wait: FlowExecutor.PendingWait?,
        input: FlowExecutor.PendingInput?
    ): ExecutionDetail {
        val nodes = nodeExecRepo.findByExecutionIdOrderBySeqAsc(e.id).map { toView(it) }
        val pc = if (pending == null) null else PendingClientRequest(
            pending.nodeId, pending.nodeName, pending.method, pending.url,
            pending.headers, pending.body, pending.respType
        )
        val pf = if (form == null) null else PendingFormRequest(
            form.nodeId, form.nodeName, form.action, form.method,
            (form.fields ?: emptyList()).map { PendingFormRequest.FormField(it.key, it.value) }
        )
        val pw = if (wait == null) null else PendingWaitRequest(
            wait.nodeId, wait.nodeName, wait.timeoutSec, wait.receiveUrl
        )
        val pi = if (input == null) null else PendingInputRequest(
            input.nodeId, input.nodeName, input.message,
            (input.fields ?: emptyList()).map { PendingInputRequest.InputField(it.key, it.label, it.type) }
        )
        return ExecutionDetail(
            e.id, e.flowId, e.flowVersionId, e.status,
            e.trigger, e.triggeredBy, e.startedAt, e.finishedAt, e.error,
            nodes, pc, pf, pw, pi
        )
    }

    private fun toView(n: NodeExecution): NodeExecutionView {
        val outputJson = n.outputJson
        val output = if (outputJson == null) null else json.readTree(outputJson)
        return NodeExecutionView(
            n.id, n.nodeId, n.nodeName, n.nodeType,
            n.seq, n.status, n.httpStatus, n.durationMs, n.isOk,
            n.requestText, n.responseText, output
        )
    }

    private fun currentUser(): String? {
        // 인증 도입 전: null. 후속 Phase에서 SecurityContext(OIDC subject)로 채운다.
        return null
    }

    companion object {
        /** 브라우저가 만든 relay 실행ID — 영숫자 8~64자만 인정(수신 URL 경로에 들어간다). */
        private val RELAY_RUN_ID: Pattern = Pattern.compile("^[A-Za-z0-9]{8,64}$")

        private fun toResumeInput(req: ResumeRequest?): FlowExecutor.ResumeInput {
            if (req == null) {
                return FlowExecutor.ResumeInput(null, null, null, null, null, null)
            }
            val cb = if (req.callback == null) null
            else FlowExecutor.ResumeInput.Callback(
                req.callback.method, req.callback.url, req.callback.headers, req.callback.body
            )
            return FlowExecutor.ResumeInput(
                req.status, req.body, req.error, req.popupOpened, cb, req.formValues
            )
        }

        private fun sanitizeRelayRunId(raw: String?): String? {
            if (raw == null || !RELAY_RUN_ID.matcher(raw).matches()) {
                return null
            }
            return raw
        }

        private fun sanitizeRelayBase(raw: String?): String? {
            if (raw == null || raw.isBlank() || raw.length > 200) {
                return null
            }
            var base = raw.trim()
            if (!base.startsWith("http://") && !base.startsWith("https://")) {
                return null
            }
            while (base.endsWith("/")) {
                base = base.substring(0, base.length - 1)
            }
            return base
        }

        private fun msg(e: Exception): String = e.message ?: e.toString()

        private fun clamp(limit: Int): Int {
            if (limit <= 0) {
                return 50
            }
            return minOf(limit, 200)
        }
    }
}
