package com.flowlink.execution

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.error.TooManyRequestsException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Execution
import com.flowlink.core.domain.ExecutionStatus
import com.flowlink.core.domain.ExecutionSuspension
import com.flowlink.core.domain.NodeExecution
import com.flowlink.core.domain.TriggerType
import com.flowlink.core.graph.NodeType
import com.flowlink.core.repository.ExecutionRepository
import com.flowlink.core.repository.ExecutionSuspensionRepository
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
import com.flowlink.execution.engine.RunStateSnapshot
import com.flowlink.execution.engine.StateCrypto
import com.flowlink.settings.RelayBaseResolver
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.data.domain.PageRequest
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.support.TransactionTemplate
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * 워크플로 실행의 진입점 + 영속화 경계.
 *
 * **비동기 + 내구(P2)**: POST 실행은 Execution(RUNNING) 저장 후 즉시 반환하고 전용 워커 풀이 노드를
 * 수행한다. 중단(WAITING) 상태는 [ExecutionSuspension] 으로 DB 영속(스냅샷 AES-GCM 암호화) —
 * 서버 재시작에도 wait/client/form/input 실행이 살아남고, 기동 시 타임아웃을 재무장한다.
 * 이중 재개 방지는 조건부 DELETE 영향행수 CAS([claim]). DB 트랜잭션을 외부 호출 동안
 * 길게 잡지 않도록, 노드별 결과는 짧은 독립 트랜잭션으로 즉시 저장한다.
 */
@Service
class ExecutionService(
    private val flowRepo: FlowRepository,
    private val versionRepo: FlowVersionRepository,
    private val executionRepo: ExecutionRepository,
    private val nodeExecRepo: NodeExecutionRepository,
    private val suspensionRepo: ExecutionSuspensionRepository,
    private val flowExecutor: FlowExecutor,
    private val json: JsonService,
    private val props: ExecutionProperties,
    private val relayResolver: RelayBaseResolver,
    txManager: PlatformTransactionManager,
) {
    private val mapper: ObjectMapper = json.mapper()

    /** claim(조건부 DELETE)·suspension upsert 용 프로그램적 트랜잭션 — 서비스 메서드가 비트랜잭션이라 프록시 자기호출 문제를 피한다. */
    private val tx = TransactionTemplate(txManager)

    /** suspension run_state 암호화(ctx 에 SET 시크릿 비마스킹 값이 있어 평문 저장 금지). */
    private val crypto = StateCrypto(props.stateSecret)

    /**
     * 중단(WAITING) 실행의 재개 상태 **라이브 캐시** — 진실원은 DB([ExecutionSuspension]).
     * 캐시 히트면 재파싱/복호화 없이 이어 실행, 미스(재시작 후)면 DB 스냅샷으로 rehydrate.
     */
    private val suspensions: MutableMap<UUID, Suspended> = ConcurrentHashMap()

    /** wait 타임아웃 자동 재개용 스케줄러(데몬). 콜백이 먼저 오면 예약은 취소된다. */
    private val scheduler: ScheduledExecutorService =
        Executors.newScheduledThreadPool(1) { r ->
            Thread(r, "wait-timeout").apply { isDaemon = true }
        }

    /** 실행/재개 연속 실행 전용 워커 풀 — 큐 초과 제출은 429(TooManyRequests) 거절. */
    private val worker: ThreadPoolExecutor = ThreadPoolExecutor(
        props.worker.poolSize, props.worker.poolSize, 60L, TimeUnit.SECONDS,
        ArrayBlockingQueue(props.worker.queueCapacity)
    ) { r -> Thread(r, "flowlink-exec-" + WORKER_SEQ.incrementAndGet()).apply { isDaemon = true } }

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

        // 비동기: 실행은 워커 풀에서, 응답은 즉시(RUNNING). 프론트는 GET 폴링으로 pending/종료를 감지한다.
        // tenant/user/relayBase 는 위에서 요청 스레드에 이미 캡처됨(RelayBaseResolver 는 요청 스레드 전용 오리진 자동을 씀).
        try {
            worker.execute {
                inWorker(execId, tenant) {
                    val outcome = flowExecutor.execute(state, recorder(execId))
                    settle(execId, outcome, state, tenant, aborted = false)
                }
            }
        } catch (e: RejectedExecutionException) {
            execution.markFailed("실행 큐가 가득 차 시작하지 못했습니다.")
            executionRepo.save(execution)
            throw TooManyRequestsException("동시 실행이 너무 많습니다 — 잠시 후 다시 시도하세요.")
        }
        return detail(execution, null, null, null, null)
    }

    /** 워커 공통 래퍼 — TenantContext 수동 전파 + 미처리 예외는 실행 FAILED 로 마감. */
    private fun inWorker(execId: UUID, tenant: String, body: () -> Unit) {
        TenantContext.setTenantId(tenant)
        try {
            body()
        } catch (e: Exception) {
            log.error("실행 워커 오류(exec={}): {}", execId, msg(e), e)
            try {
                executionRepo.findById(execId).ifPresent { ex ->
                    if (ex.status == ExecutionStatus.RUNNING || ex.status == ExecutionStatus.WAITING) {
                        ex.markFailed("실행 중 오류: " + msg(e))
                        executionRepo.save(ex)
                    }
                }
                tx.execute { suspensionRepo.deleteByExecutionId(execId) }
                suspensions.remove(execId)
            } catch (cleanup: Exception) {
                log.warn("실행 실패 정리 오류(exec={}): {}", execId, msg(cleanup))
            }
        } finally {
            TenantContext.clear()
        }
    }

    /** 실행/재개 종료 공통 — 상태 반영 + suspension 영속/정리. */
    private fun settle(
        execId: UUID, outcome: FlowExecutor.Outcome,
        state: FlowExecutor.RunState, tenant: String, aborted: Boolean,
    ) {
        val execution = executionRepo.findByIdAndTenantId(execId, tenant)
            .orElseThrow { NotFoundException.of("Execution", execId) }
        if (aborted && outcome.status == ExecutionStatus.FAILED) {
            execution.markCancelled(outcome.error) // 사용자 중단(⏹)은 실패가 아니라 취소
        } else {
            applyStatus(execution, outcome)
        }
        rememberIfPending(execId, outcome, state, tenant)
        executionRepo.save(execution)
    }

    /**
     * 중단된 실행(client HTTP / form / input / wait)을, 브라우저가 돌려준 입력으로 이어서 실행한다.
     * claim(이중 재개 CAS) 성공 시 연속 실행을 워커 풀로 넘기고 **즉시 현재 상태를 반환** —
     * 프론트는 GET 폴링으로 다음 pending/종료를 감지한다. claim 실패(이미 재개/완료)는 멱등.
     */
    fun resume(executionId: UUID, req: ResumeRequest?): ExecutionDetail {
        val tenant = TenantContext.getTenantId()
        val execution = executionRepo.findByIdAndTenantId(executionId, tenant)
            .orElseThrow { NotFoundException.of("Execution", executionId) }
        val nodeId = req?.nodeId
        val suspended = if (nodeId == null) null else claim(executionId, nodeId)
        if (suspended == null || suspended.tenant != tenant) {
            return detail(execution, null, null, null, null) // 멱등
        }
        submitResume(executionId, suspended, req)
        return detail(execution, null, null, null, null)
    }

    /** claim 완료된 재개를 워커 풀에 제출. 큐 포화 시 호출 스레드에서 직접 수행(재개 입력 유실 방지). */
    private fun submitResume(executionId: UUID, suspended: Suspended, req: ResumeRequest?) {
        val task = { inWorker(executionId, suspended.tenant) { doResumeWork(executionId, suspended, req) } }
        try {
            worker.execute(task)
        } catch (e: RejectedExecutionException) {
            log.warn("워커 큐 포화 — 재개를 호출 스레드에서 수행(exec={})", executionId)
            task()
        }
    }

    /** 재개 실행 + 상태반영 + 영속화(워커 스레드, tenant 세팅 완료 상태). */
    private fun doResumeWork(executionId: UUID, suspended: Suspended, req: ResumeRequest?) {
        val outcome: FlowExecutor.Outcome
        try {
            outcome = flowExecutor.resume(
                suspended.state, toResumeInput(req),
                req?.durationMs ?: 0L,
                recorder(executionId)
            )
        } catch (e: Exception) {
            val execution = executionRepo.findById(executionId).orElse(null) ?: return
            execution.markFailed("재개 중 오류: " + msg(e))
            executionRepo.save(execution)
            return
        }
        settle(executionId, outcome, suspended.state, suspended.tenant, aborted = req?.aborted == true)
    }

    /**
     * 재개 권한 claim — DB 조건부 DELETE 영향행수 1 = 승자(콜백/타임아웃/resume 경합 직렬화).
     * 인메모리 캐시가 있으면 그 RunState 를, 없으면(서버 재시작 후) DB 스냅샷을 복호화·rehydrate 한다.
     */
    private fun claim(executionId: UUID, nodeId: String): Suspended? {
        val row = tx.execute {
            val r = suspensionRepo.findById(executionId).orElse(null) ?: return@execute null
            if (r.pendingNodeId != nodeId) return@execute null
            if (suspensionRepo.deleteByExecutionIdAndPendingNodeId(executionId, nodeId) == 0) return@execute null
            r
        } ?: return null
        val mem = suspensions.remove(executionId)
        mem?.future?.cancel(false)
        if (mem != null) {
            return mem
        }
        return rehydrateFromRow(row)
    }

    /** 재시작 후 콜백/재개 — Execution→FlowVersion graphJson + 복호화 스냅샷으로 RunState 복원. */
    private fun rehydrateFromRow(row: ExecutionSuspension): Suspended? {
        return try {
            val execution = executionRepo.findById(row.executionId).orElse(null) ?: return null
            val version = versionRepo.findById(execution.flowVersionId).orElse(null) ?: return null
            val graph = json.parseGraph(version.graphJson)
            val snap = mapper.readValue(crypto.decrypt(row.runState), RunStateSnapshot::class.java)
            val state = flowExecutor.rehydrate(graph, snap)
            val outcome = row.outcomeJson?.let { mapper.readValue(it, FlowExecutor.Outcome::class.java) }
                ?: FlowExecutor.Outcome(ExecutionStatus.WAITING, null, null, null, null, null)
            Suspended(state, row.tenantId, outcome)
        } catch (e: Exception) {
            log.error("suspension 재수화 실패(exec={}): {}", row.executionId, msg(e))
            null
        }
    }

    @Transactional(readOnly = true)
    fun get(executionId: UUID): ExecutionDetail {
        val e = executionRepo.findByIdAndTenantId(executionId, TenantContext.getTenantId())
            .orElseThrow { NotFoundException.of("Execution", executionId) }
        // 아직 중단(대기) 중이면 pending 명세를 함께 반환 — 프론트가 폴링만으로 대기 상태를 유지/재개 감지.
        // (이게 없으면 wait 대기 루프가 첫 재조회에서 pending=null 을 보고 바로 끝나 "콜백 대기가 안 되는" 증상)
        if (e.status == ExecutionStatus.WAITING) {
            val tenant = TenantContext.getTenantId()
            val o = suspensions[executionId]?.takeIf { it.tenant == tenant }?.outcome
                ?: dbOutcome(executionId, tenant) // 재시작 후에도 계약 유지(DB outcome_json)
            if (o != null) {
                return detail(e, o.pendingClient, o.pendingForm, o.pendingWait, o.pendingInput)
            }
        }
        return detail(e, null, null, null, null)
    }

    /** suspension DB 행의 pending 명세 — 인메모리 캐시 미스(재시작 직후) 폴링 대응. */
    private fun dbOutcome(executionId: UUID, tenant: String): FlowExecutor.Outcome? {
        val row = suspensionRepo.findById(executionId).orElse(null) ?: return null
        if (row.tenantId != tenant) return null
        return try {
            row.outcomeJson?.let { mapper.readValue(it, FlowExecutor.Outcome::class.java) }
        } catch (e: Exception) {
            log.warn("outcome 역직렬화 실패(exec={}): {}", executionId, msg(e))
            null
        }
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
     * 중단(pending)되면 재개 상태를 인메모리 캐시 + **DB 영속**(스냅샷 암호화)하고, 종료면 정리한다.
     * wait 로 중단되면 타임아웃 자동 재개를 예약한다(이전 예약은 취소). form/input/client 는 예약 없음
     * (브라우저 resume 대기 — 재시작해도 DB 스냅샷으로 재개 가능).
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
            val deadline = if (pw == null) null else Instant.now().plusSeconds(waitSecs(pw.timeoutSec))
            persistSuspension(execId, tenant, state, outcome, deadline)
            if (pw != null && pw.nodeId != null) {
                scheduleWaitTimeout(execId, pw.nodeId, waitSecs(pw.timeoutSec), suspended)
            }
        } else {
            suspensions.remove(execId)
            tx.execute { suspensionRepo.deleteByExecutionId(execId) }
        }
    }

    /** 스냅샷 직렬화 → 암호화 → suspension 행 upsert(merge). */
    private fun persistSuspension(
        execId: UUID, tenant: String, state: FlowExecutor.RunState,
        outcome: FlowExecutor.Outcome, deadline: Instant?,
    ) {
        try {
            val snapJson = mapper.writeValueAsString(flowExecutor.snapshot(state))
            val outcomeJson = mapper.writeValueAsString(outcome)
            val pendingNodeId = flowExecutor.snapshot(state).pendingNodeId
                ?: outcome.pendingWait?.nodeId ?: outcome.pendingClient?.nodeId
                ?: outcome.pendingForm?.nodeId ?: outcome.pendingInput?.nodeId ?: "?"
            val row = ExecutionSuspension.of(execId, tenant, pendingNodeId, crypto.encrypt(snapJson), outcomeJson, deadline)
            tx.execute { suspensionRepo.save(row) }
        } catch (e: Exception) {
            // 영속 실패는 내구성 저하일 뿐(인메모리 캐시로는 계속 동작) — 실행 자체를 죽이지 않는다.
            log.error("suspension 영속 실패(exec={}): {}", execId, msg(e))
        }
    }

    /** wait 노드 중단 시 timeoutSec 후 자동 타임아웃 재개를 예약한다(콜백이 먼저 오면 취소). */
    private fun scheduleWaitTimeout(execId: UUID, nodeId: String, secs: Long, suspended: Suspended) {
        try {
            suspended.future = scheduler.schedule(
                { onWaitTimeout(execId, nodeId, secs) }, secs, TimeUnit.SECONDS
            )
        } catch (e: Exception) {
            log.warn("wait 타임아웃 예약 실패(exec={}, node={}): {}", execId, nodeId, msg(e))
        }
    }

    /**
     * wait 타임아웃 발화 — claim 성공 시 해당 wait 노드를 error 로 재개(실행 FAILED).
     * 이미 콜백/완료됐거나 다른 wait 로 교체된 경우 claim 이 실패해 멱등하게 무시된다.
     */
    private fun onWaitTimeout(execId: UUID, nodeId: String, secs: Long) {
        val claimed = claim(execId, nodeId) ?: return
        val req = ResumeRequest(
            nodeId, null, null,
            "콜백 대기 타임아웃 — ${secs}초 동안 콜백이 오지 않았습니다.",
            null, null, null, null, null
        )
        inWorker(execId, claimed.tenant) { doResumeWork(execId, claimed, req) }
    }

    /**
     * 기동 복구 — ① suspension 이 있는 대기 실행의 wait 타임아웃 재무장(경과분은 즉시 발화)
     * ② suspension 없는 진행 중(RUNNING/WAITING) 고아는 FAILED 로 reconcile(크래시/재시작으로 소실된 실행).
     */
    @EventListener(ApplicationReadyEvent::class)
    fun recoverOnStartup() {
        val rows = suspensionRepo.findAll()
        for (row in rows) {
            val deadline = row.waitDeadline ?: continue // wait 외 pending 은 브라우저 resume 대기(타이머 없음)
            val delay = maxOf(0L, deadline.epochSecond - Instant.now().epochSecond)
            try {
                scheduler.schedule({ onWaitTimeout(row.executionId, row.pendingNodeId, delay) }, delay, TimeUnit.SECONDS)
                log.info("wait 타임아웃 재무장(exec={}, node={}, {}초 후)", row.executionId, row.pendingNodeId, delay)
            } catch (e: Exception) {
                log.warn("타임아웃 재무장 실패(exec={}): {}", row.executionId, msg(e))
            }
        }
        val alive = rows.map { it.executionId }.toSet()
        val orphans = executionRepo.findByStatusIn(listOf(ExecutionStatus.RUNNING, ExecutionStatus.WAITING))
            .filter { it.id !in alive }
        for (e in orphans) {
            e.markFailed("서버 재시작으로 중단된 실행")
            executionRepo.save(e)
        }
        if (orphans.isNotEmpty() || rows.isNotEmpty()) {
            log.info("기동 복구: suspension {}건 재무장 대상 확인, 고아 실행 {}건 FAILED 처리", rows.size, orphans.size)
        }
        if (crypto.isDevKey) {
            log.warn("suspension 암호화가 dev 고정키로 동작 중 — 공유 배포에선 FLOWLINK_EXECUTION_STATE_SECRET 설정 권장")
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
        // claim(조건부 DELETE CAS) — 교체/완료/타임아웃 선점이면 멱등 OK. 재시작 후엔 DB 스냅샷 재수화.
        val claimed = claim(execId, nodeId) ?: return RelayResponse.plainOk()
        val resp = waitResponseFor(claimed.state, nodeId) // 재개 전(state 접근 가능) 응답 산출
        // 수신 URL 은 콜백 요청 스레드에서 확정(오리진 자동이 가장 정확) 후, 재개는 워커로 — ACK 는 즉시.
        val cb = CallbackPayload(
            method, FlowExecutor.receiveUrl(relayResolver.resolve(), execId.toString(), nodeId), headers, bodyText
        )
        val req = ResumeRequest(nodeId, null, null, null, null, null, cb, null, null)
        submitResume(execId, claimed, req)
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
        private val WORKER_SEQ = java.util.concurrent.atomic.AtomicInteger()

        private fun waitSecs(timeoutSec: Int): Long = if (timeoutSec <= 0) 120L else timeoutSec.toLong()

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
