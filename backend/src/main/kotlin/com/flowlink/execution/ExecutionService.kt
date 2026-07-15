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
import com.flowlink.execution.dto.ResumeRequest.CallbackPayload
import com.flowlink.execution.engine.ExecutionContext
import com.flowlink.execution.engine.FlowExecutor
import com.flowlink.execution.engine.NodeRecorder
import com.flowlink.settings.RelayBaseResolver
import org.slf4j.LoggerFactory
import org.springframework.data.domain.PageRequest
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

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
    private val props: ExecutionProperties,
    private val relayResolver: RelayBaseResolver
) {
    private val mapper: ObjectMapper = json.mapper()

    /**
     * 브라우저 협업 노드(client HTTP / form / input)와 wait(콜백 대기)에서 WAITING 으로 중단된 실행의
     * 재개 상태(인메모리). 단일 인스턴스/세션 한정 — 서버 재시작 시 소실되며 내구성 보관은 후속 Phase.
     */
    private val suspensions: MutableMap<UUID, Suspended> = ConcurrentHashMap()

    /** wait 타임아웃 자동 재개용 스케줄러(데몬). 콜백이 먼저 오면 예약은 취소된다. */
    private val scheduler: ScheduledExecutorService =
        Executors.newScheduledThreadPool(1) { r ->
            Thread(r, "wait-timeout").apply { isDaemon = true }
        }

    /**
     * 중단된 실행의 재개 상태. [future] 는 wait 노드의 타임아웃 자동 재개 예약(콜백 수신/재개 시 취소).
     * future 를 통해 접근하는 스레드(콜백/타임아웃)와 suspensions 접근은 execId 단위로 원자 교체·조건 제거로 직렬화한다.
     * [outcome] 은 중단 시점의 pending 명세 — [get] 폴링이 대기 중에도 pending 을 돌려줘
     * 프론트 대기 루프(카운트다운/수신 URL/재개 감지)가 유지되게 한다.
     */
    private class Suspended(
        val state: FlowExecutor.RunState,
        val tenant: String,
        val outcome: FlowExecutor.Outcome
    ) {
        @Volatile
        var future: ScheduledFuture<*>? = null
    }

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
        //
        // 콜백은 백엔드(RelayController)가 직접 받아 재개한다(relay.js 불필요). 수신 URL 은 이 실행ID 기반으로 확정.
        // RunRequest.relayRunId/relayBase(구 프론트가 아직 보냄)는 하위호환 위해 무시한다.
        // base 우선순위: 화면 설정(DB) → env/yml 명시 → 접속 오리진 자동(RelayBaseResolver)
        val relayBase = relayResolver.resolve()
        val relayRunId = execId.toString()
        for (n in graph.nodesOrEmpty()) {
            if (n.effectiveType() == NodeType.WAIT) {
                ctx.putSeed(n.id!!, mapOf("url" to FlowExecutor.receiveUrl(relayBase, relayRunId, n.id)))
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
        // 아직 중단(대기) 중이면 pending 명세를 함께 반환 — 프론트가 폴링만으로 대기 상태를 유지/재개 감지.
        // (이게 없으면 wait 대기 루프가 첫 재조회에서 pending=null 을 보고 바로 끝나 "콜백 대기가 안 되는" 증상)
        val s = suspensions[executionId]
        if (s != null && s.tenant == TenantContext.getTenantId() && e.status == ExecutionStatus.WAITING) {
            val o = s.outcome
            return detail(e, o.pendingClient, o.pendingForm, o.pendingWait, o.pendingInput)
        }
        return detail(e, null, null, null, null)
    }

    @Transactional(readOnly = true)
    fun listForFlow(flowId: UUID, limit: Int): List<ExecutionSummary> {
        // 테넌트 스코프 소유 확인 선행 — flowId 만 알면 타 테넌트 실행 요약이 새던 구멍 방지.
        flowRepo.findByIdAndTenantId(flowId, TenantContext.getTenantId())
            .orElseThrow { NotFoundException.of("Flow", flowId) }
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

    /**
     * 중단(pending)되면 재개 상태를 보관하고, 그 외(완료/실패)면 비운다.
     * wait 로 중단되면 타임아웃 자동 재개를 예약한다(이전 예약은 취소). form/input/client 는 예약 없음.
     */
    private fun rememberIfPending(
        execId: UUID, outcome: FlowExecutor.Outcome,
        state: FlowExecutor.RunState, tenant: String
    ) {
        // 이전 wait 타임아웃 예약이 남아 있으면 취소(재개/교체로 무효화).
        suspensions[execId]?.future?.cancel(false)
        if (outcome.status == ExecutionStatus.WAITING && outcome.isPending()) {
            val suspended = Suspended(state, tenant, outcome)
            suspensions[execId] = suspended
            val pw = outcome.pendingWait
            if (pw != null && pw.nodeId != null) {
                scheduleWaitTimeout(execId, pw.nodeId, pw.timeoutSec, suspended)
            }
        } else {
            suspensions.remove(execId)
        }
    }

    /** wait 노드 중단 시 timeoutSec 후 자동 타임아웃 재개를 예약한다(콜백이 먼저 오면 취소). */
    private fun scheduleWaitTimeout(execId: UUID, nodeId: String, timeoutSec: Int, suspended: Suspended) {
        val secs = if (timeoutSec <= 0) 120L else timeoutSec.toLong()
        try {
            suspended.future = scheduler.schedule(
                { onWaitTimeout(execId, nodeId, secs, suspended) }, secs, TimeUnit.SECONDS
            )
        } catch (e: Exception) {
            log.warn("wait 타임아웃 예약 실패(exec={}, node={}): {}", execId, nodeId, msg(e))
        }
    }

    /**
     * wait 타임아웃 발화 — 해당 wait 노드를 error 로 재개(실행 FAILED).
     * [expected] 로 조건부 원자 제거해, 이미 콜백/완료됐거나 다른 wait 로 교체된 경우는 멱등하게 무시한다.
     * 콜백 스레드가 아니므로 TenantContext 를 수동 set/clear 한다.
     */
    private fun onWaitTimeout(execId: UUID, nodeId: String, secs: Long, expected: Suspended) {
        if (!suspensions.remove(execId, expected)) {
            return // 이미 콜백 수신/완료 또는 다른 대기로 교체됨 — 멱등
        }
        TenantContext.setTenantId(expected.tenant)
        try {
            val req = ResumeRequest(
                nodeId, null, null,
                "콜백 대기 타임아웃 — ${secs}초 동안 콜백이 오지 않았습니다.",
                null, null, null, null, null
            )
            doResume(execId, expected, req)
        } catch (e: Exception) {
            log.warn("wait 타임아웃 재개 오류(exec={}): {}", execId, msg(e))
        } finally {
            TenantContext.clear()
        }
    }

    /**
     * wait 콜백 수신(RelayController → 이 메서드). 대기 중인 그 wait 노드면 타임아웃 예약을 취소하고
     * 콜백을 기존 resume 계약(ResumeRequest.callback)으로 변환해 백엔드가 직접 재개한다.
     * 이미 완료/타임아웃됐거나 늦은/불일치 콜백은 멱등하게(상태 변경 없이) 응답만 반환한다.
     *
     * @return 그 wait 노드에 설정된 콜백 응답(callbackRespType/Body). 미설정/멱등이면 text "OK".
     */
    fun recordWaitCallback(
        execId: UUID, nodeId: String, method: String,
        headers: Map<String, String>, bodyText: String?
    ): RelayResponse {
        val current = suspensions[execId]
        // 대기 중인 노드가 이 콜백의 노드와 일치할 때만 원자적으로 claim(교체/완료면 값 불일치 → 실패).
        if (current == null || current.state.pendingNodeId != nodeId || !suspensions.remove(execId, current)) {
            return RelayResponse.plainOk()
        }
        current.future?.cancel(false)
        val resp = waitResponseFor(current.state, nodeId) // 재개 전(state 접근 가능) 응답 산출
        TenantContext.setTenantId(current.tenant)
        try {
            val cb = CallbackPayload(
                method, FlowExecutor.receiveUrl(relayResolver.resolve(), execId.toString(), nodeId), headers, bodyText
            )
            val req = ResumeRequest(nodeId, null, null, null, null, null, cb, null, null)
            doResume(execId, current, req)
        } catch (e: Exception) {
            log.warn("wait 콜백 재개 오류(exec={}, node={}): {}", execId, nodeId, msg(e))
        } finally {
            TenantContext.clear()
        }
        return resp
    }

    /** wait 노드에 설정된 콜백 응답을 산출한다 — 콜백 발신자(게이트웨이/노티)에게 돌려줄 ACK. */
    private fun waitResponseFor(state: FlowExecutor.RunState, nodeId: String): RelayResponse {
        val node = state.byId[nodeId]
        return RelayResponse.of(node?.callbackRespType, node?.callbackRespBody)
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
        // OIDC 모드면 JwtRoleConverter 가 name=preferred_username(없으면 sub)으로 세팅. dev 모드는 null.
        val auth = SecurityContextHolder.getContext().authentication
        return if (auth is JwtAuthenticationToken) auth.name else null
    }

    /**
     * wait 콜백에 돌려줄 응답(콜백 발신자용 ACK) — RelayController 가 그대로 내보낸다.
     * 노드에 설정된 callbackRespType(text|html|json)/callbackRespBody 로부터 산출한다.
     */
    data class RelayResponse(val contentType: String, val body: String) {
        companion object {
            fun of(type: String?, body: String?): RelayResponse {
                if (type == null && body.isNullOrEmpty()) {
                    return plainOk()
                }
                val ct = when (type?.lowercase()) {
                    "html" -> "text/html; charset=UTF-8"
                    "json" -> "application/json; charset=UTF-8"
                    else -> "text/plain; charset=UTF-8"
                }
                return RelayResponse(ct, body ?: "")
            }

            fun plainOk(): RelayResponse = RelayResponse("text/plain; charset=UTF-8", "OK")
        }
    }

    companion object {
        private val log = LoggerFactory.getLogger(ExecutionService::class.java)

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

        private fun msg(e: Exception): String = e.message ?: e.toString()

        private fun clamp(limit: Int): Int {
            if (limit <= 0) {
                return 50
            }
            return minOf(limit, 200)
        }
    }
}
