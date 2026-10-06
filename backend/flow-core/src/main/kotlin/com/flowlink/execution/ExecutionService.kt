package com.flowlink.execution

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.agent.AgentRunOptions
import com.flowlink.agent.AgentRunStarted
import com.flowlink.agent.AgentTaskCompleted
import com.flowlink.agent.AgentTaskService
import com.flowlink.agent.PendingAgent
import com.flowlink.common.host.LocalServerConnection
import com.flowlink.common.host.LocalRuntimeSession
import com.flowlink.environment.EnvironmentService
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
import com.flowlink.execution.dto.SingleNodeRunResult
import com.flowlink.execution.dto.ResumeRequest.CallbackPayload
import com.flowlink.execution.engine.ExecutionContext
import com.flowlink.execution.engine.FlowExecutor
import com.flowlink.execution.engine.NodeRecorder
import com.flowlink.execution.engine.RunStateSnapshot
import com.flowlink.execution.engine.SecretMasker
import com.flowlink.settings.RelayBaseResolver
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.ApplicationEventPublisher
import org.springframework.context.event.EventListener
import org.springframework.data.domain.PageRequest
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
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
    private val notifier: com.flowlink.notify.NotificationService,
    private val secretService: com.flowlink.secret.SecretService,
    private val crypto: com.flowlink.common.crypto.CryptoProvider,
    private val workspace: com.flowlink.workspace.WorkspaceService,
    private val environmentService: EnvironmentService,
    private val agentTasks: AgentTaskService,
    private val desktopSession: ObjectProvider<LocalRuntimeSession>,
    private val desktopConnection: ObjectProvider<LocalServerConnection>,
    private val events: ApplicationEventPublisher,
    private val callbackInbox: WaitCallbackInbox,
    private val artifactCleanup: com.flowlink.maintenance.ExecutionArtifactCleanup,
    txManager: PlatformTransactionManager,
    private val updateGate: com.flowlink.common.lifecycle.RuntimeUpdateGate = com.flowlink.common.lifecycle.RuntimeUpdateGate(),
) {
    private val mapper: ObjectMapper = json.mapper()

    /** claim(조건부 DELETE)·suspension upsert 용 프로그램적 트랜잭션 — 서비스 메서드가 비트랜잭션이라 프록시 자기호출 문제를 피한다. */
    private val tx = TransactionTemplate(txManager)
    private val managedTx = TransactionTemplate(txManager).apply {
        propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRES_NEW
    }

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

    /**
     * 단일 노드 독립 실행 — 그 노드 하나만 즉석 실행하고 결과를 돌려준다(이력 미저장).
     * **env/secret/input 은 시드**해 `{{ 키@env }}`·`{{ 이름@secret }}`·`{{ 키@input }}` 가 해석된다(전체 실행과 동일).
     * 상류 노드 출력(`{{ 키@노드 }}`)만 단독 실행이라 비어 있다. HTTP/TCP/SET/IF/SWITCH/ASSERT/TRANSFORM 지원, 대기/폼/입력/client 는 미지원.
     */
    @Transactional(readOnly = true)
    fun runSingleNode(flowId: UUID, nodeId: String, req: RunRequest? = null): SingleNodeRunResult =
        updateGate.work { runSingleNodeAllowed(flowId, nodeId, req) }

    private fun runSingleNodeAllowed(flowId: UUID, nodeId: String, req: RunRequest?): SingleNodeRunResult {
        // flow 는 전역 공유 — 공유 테넌트로 조회(로그인 테넌트 무관).
        val flow = flowRepo.findByIdAndTenantId(flowId, TenantContext.SHARED_FLOW_TENANT)
            .orElseThrow { NotFoundException.of("Flow", flowId) }

        if (!workspace.supportsWorkspace(flow.workspaceId)) throw com.flowlink.common.error.ForbiddenException("이 실행 위치에서 사용할 수 없는 워크스페이스입니다.")
        workspace.requireWrite(workspace.currentUsername(), flow.workspaceId) // VIEWER 는 실행 불가(조회만)
        val version = versionRepo.findByFlowIdAndVersionNo(flowId, flow.currentVersion)
            .orElseThrow { NotFoundException.of("FlowVersion", "$flowId/v${flow.currentVersion}") }
        val graph = json.parseGraph(version.graphJson)
        val node = graph.nodesOrEmpty().find { it.id == nodeId }
            ?: throw NotFoundException.of("Node", nodeId)

        if (node.executionAgent != null || node.agentEnvironment != null || node.agentWorkspaceId != null || node.agentMock != null || !req?.agentEnvironments.isNullOrEmpty()) {
            throw BadRequestException("에이전트 노드는 전체 실행 API의 onlyNodeId를 사용하세요. 목적지 환경을 명시적으로 선택해야 합니다.")
        }

        // 전체 실행과 동일하게 input/env 시드 + 활성 환경 시크릿 오버레이 시드(명시 스코프에만 보이는 putSeed).
        val ctx = ExecutionContext().apply { workspaceId = flow.workspaceId }
        seedWorkspaceInput(ctx, req)
        val secrets = secretMap(req?.envName?.trim()?.takeIf { it.isNotEmpty() }, flow.workspaceId)
        if (secrets.isNotEmpty()) ctx.putSeed("secret", secrets)
        // 상류 바인딩({{ 키@노드 }}) 수동 값 — 사용자가 입력한 이전 노드 출력을 그 노드 id 로 시드.
        // bare {{ 키 }} 는 프론트가 __prev 로 묶어 보내고, nearest-upstream 탐색에 걸린다.
        req?.upstream?.takeIf { it.isObject }?.fields()?.forEach { (srcId, v) ->
            runCatching {
                val m = json.mapper().convertValue(v, object : com.fasterxml.jackson.core.type.TypeReference<Map<String, Any?>>() {})
                if (m.isNotEmpty()) ctx.putOutput(srcId, m)
            }
        }

        val t0 = System.nanoTime()
        val r = flowExecutor.runSingleNode(node, ctx)
        val durationMs = (System.nanoTime() - t0) / 1_000_000
        // 응답도 실행 이력과 동일하게 시크릿 마스킹 — 단일 실행 결과가 패널에 그대로 표시되므로
        // 시크릿 평문(요청 헤더/출력 값)이 화면·네트워크 응답으로 새지 않게 한다.
        val masks = SecretMasker.variants(secrets.values)
        val output = if (r.value == null || masks.isEmpty()) r.value
            else json.mapper().readTree(SecretMasker.mask(json.toJson(r.value), masks))
        return SingleNodeRunResult(
            r.ok, r.httpStatus, output,
            SecretMasker.mask(r.requestText, masks), SecretMasker.mask(r.responseText, masks),
            durationMs
        )
    }

    /**
     * TCP 요청 전문 미리보기(전송 없음) — 조립 바이트/필드 오프셋/오버플로.
     * [override] 가 있으면(편집 중 노드) 그걸 조립(순수 계산이라 안전), 없으면 저장된 그래프의 노드를 조립.
     */
    @Transactional(readOnly = true)
    fun previewTcp(flowId: UUID, nodeId: String, override: com.flowlink.core.graph.GraphNode? = null, envName: String? = null): com.flowlink.protocol.ProtocolDtos.PreviewResult {
        val flow = flowRepo.findByIdAndTenantId(flowId, TenantContext.SHARED_FLOW_TENANT)
            .orElseThrow { NotFoundException.of("Flow", flowId) }
        workspace.requireWrite(workspace.currentUsername(), flow.workspaceId)
        val node = if (override != null) override else {
            // flow 는 전역 공유 — 공유 테넌트로 조회. 저장 그래프를 읽으므로 워크스페이스 읽기 권한 필요.
            val flow = flowRepo.findByIdAndTenantId(flowId, TenantContext.SHARED_FLOW_TENANT)
                .orElseThrow { NotFoundException.of("Flow", flowId) }
            workspace.requireRead(workspace.currentUsername(), flow.workspaceId)
            val version = versionRepo.findByFlowIdAndVersionNo(flowId, flow.currentVersion)
                .orElseThrow { NotFoundException.of("FlowVersion", "$flowId/v${flow.currentVersion}") }
            val graph = json.parseGraph(version.graphJson)
            graph.nodesOrEmpty().find { it.id == nodeId } ?: throw NotFoundException.of("Node", nodeId)
        }
        if (node.nodeType() != NodeType.TCP) throw BadRequestException("TCP 노드가 아닙니다.")
        if (node.executionAgent != null || node.agentWorkspaceId != null || node.agentEnvironment != null) throw BadRequestException("에이전트 전문은 목적지 미리보기 API를 사용하세요.")
        if (!environmentService.exists(envName, flow.workspaceId)) throw BadRequestException("선택한 환경이 없습니다.")
        return flowExecutor.previewTcp(node, flow.workspaceId, environmentService.vars(envName, flow.workspaceId), secretMap(envName, flow.workspaceId))
    }

    // trigger 는 실행을 시작시킨 종류(MANUAL/SCHEDULE/WEBHOOK). 스케줄러·웹훅은 호출 전 TenantContext 를 세팅한다.
    fun run(flowId: UUID, req: RunRequest?, trigger: TriggerType = TriggerType.MANUAL): ExecutionDetail =
        updateGate.work { runAllowed(flowId, req, trigger) }

    private fun runAllowed(flowId: UUID, req: RunRequest?, trigger: TriggerType): ExecutionDetail {
        val tenant = TenantContext.getTenantId() // 실행(Execution) 행은 사용자별 — 아래 Execution.start·워커 전파에 사용
        // flow 는 전역 공유 — 조회만 공유 테넌트로(실행 이력은 위 tenant 로 격리 유지).
        val flow = flowRepo.findByIdAndTenantId(flowId, TenantContext.SHARED_FLOW_TENANT)
            .orElseThrow { NotFoundException.of("Flow", flowId) }

        // 워크스페이스 롤 게이트 — VIEWER 는 실행 불가(조회만). 트리거 발화(SCHEDULE/WEBHOOK)는 등록 시점에
        // 승인된 것이므로 호출자 신원(스케줄러 스레드=guest/dev)으로 재판정하지 않는다.
        if (!workspace.supportsWorkspace(flow.workspaceId)) throw com.flowlink.common.error.ForbiddenException("이 실행 위치에서 사용할 수 없는 워크스페이스입니다.")
        if (trigger == TriggerType.MANUAL) {
            workspace.requireWrite(workspace.currentUsername(), flow.workspaceId)
        }

        val versionNo = req?.versionNo ?: flow.currentVersion
        val version = versionRepo.findByFlowIdAndVersionNo(flowId, versionNo)
            .orElseThrow { NotFoundException.of("FlowVersion", "$flowId/v$versionNo") }

        val graph = json.parseGraph(version.graphJson)
        if (graph.nodesOrEmpty().size > props.maxNodesPerRun) {
            throw BadRequestException("노드 수가 상한을 초과했습니다.")
        }

        if (workspace.localRuntime || req?.agentDeviceId != null || req?.clientExecutionId != null || req?.onlyNodeId != null ||
            graph.nodesOrEmpty().any { it.executionAgent != null || it.agentEnvironment != null || it.agentWorkspaceId != null || it.agentMock != null } || !req?.agentEnvironments.isNullOrEmpty()) {
            return runManaged(flow, version, graph, req, trigger, tenant)
        }

        val inputJson: String? = req?.input?.let { if (it.isNull) null else json.toJson(it) }

        val execution = Execution.start(
            tenant, flowId, version.id, trigger, currentUser(), inputJson
        )
        executionRepo.save(execution)
        val execId = execution.id

        val ctx = ExecutionContext().apply { workspaceId = flow.workspaceId }
        seedWorkspaceInput(ctx, req)
        // 시크릿 볼트 시드 — putSeed 로 넣어 **명시 스코프 {{ 이름@secret }} 로만** 보이게 한다(bare {{키}} 의
        // nearest-upstream 오염/input·env 가림 방지 — wait URL 시드와 동일 격리). 값은 캡처 로그에서 마스킹(recorder).
        // 활성 환경(envName)의 시크릿을 공통 위에 오버레이해 시드. 없으면 공통만.
        val secrets = secretMap(req?.envName?.trim()?.takeIf { it.isNotEmpty() }, flow.workspaceId)
        if (secrets.isNotEmpty()) ctx.putSeed("secret", secrets)

        // wait(콜백 대기) 노드 수신 URL 시드 — 실행 시작 시점에 모든 wait 노드의 url 출력을 미리 확정해
        // {{ url@노드ID }} 가 wait 보다 앞의 노드(returnUrl/notiUrl)에서도 해석되게 한다.
        // putSeed: 명시 스코프/바인딩에만 보임 — bare {{ url }} 의 nearest-upstream 해석을 오염시키지 않는다.
        //
        // 콜백은 백엔드(RelayController)가 직접 받아 재개한다(relay.js 불필요). 수신 URL 은 이 실행ID 기반으로 확정.
        // RunRequest.relayRunId/relayBase(구 프론트가 아직 보냄)는 하위호환 위해 무시한다.
        // base 우선순위: 화면 설정(DB) → 접속 오리진 자동(RelayBaseResolver)
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
                    val outcome = flowExecutor.execute(state, recorder(execId, secrets.values, state))
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

    /** 관리 실행의 초기 drive는 I/O 없이 첫 작업까지 진행하고, 작업과 체크포인트를 함께 저장한다. */
    private fun runManaged(
        flow: com.flowlink.core.domain.Flow, version: com.flowlink.core.domain.FlowVersion,
        graph: com.flowlink.core.graph.FlowGraph, req: RunRequest?, trigger: TriggerType, tenant: String,
    ): ExecutionDetail {
        val owner = if (workspace.localRuntime) "local" else "server"
        val device = if (workspace.localRuntime) desktopSession.getObject().deviceId else req?.agentDeviceId ?: "server"
        if (device.isBlank() || device.length > 100 || (!workspace.localRuntime && req?.agentDeviceId == "server"))
            throw BadRequestException("올바른 PC 에이전트 ID가 필요합니다.")
        val username = workspace.currentUsername()
        val execId = req?.clientExecutionId ?: UUID.randomUUID()
        val hashSource = json.toJson(mapOf("flowId" to flow.id,
            "trigger" to trigger, "device" to device, "request" to req?.copy(clientExecutionId = null)))
        val requestHash = java.security.MessageDigest.getInstance("SHA-256").digest(hashSource.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        val relayBase = relayResolver.resolve()
        val account = if (workspace.localRuntime) desktopConnection.getObject().connectionIdentity() else null
        return managedTx.execute {
            // 동일 플로우의 동시 시작 요청을 직렬화한다. 다른 플로우의 ID 충돌은 PK로 거절된다.
            flowRepo.locked(flow.id) ?: throw NotFoundException.of("Flow", flow.id)
            executionRepo.findById(execId).orElse(null)?.let { existing ->
                if (existing.tenantId != tenant || existing.triggeredBy != username || existing.flowId != flow.id ||
                    existing.agentDeviceId != device || existing.runRequestHash != requestHash)
                    throw BadRequestException("이미 사용한 실행 ID의 계정, 장치 또는 실행 내용을 바꿀 수 없습니다.")
                if (workspace.localRuntime && existing.status == ExecutionStatus.WAITING) {
                    val options = suspensionRepo.findById(execId).orElse(null)?.let(::rehydrateFromRow)?.state?.agentRun
                    if (options != null) afterCommit {
                        events.publishEvent(AgentRunStarted(execId, tenant, options.serverUrl, options.login))
                    }
                }
                return@execute managedDetail(existing)
            }
            val only = req?.onlyNodeId?.let { id ->
                graph.nodesOrEmpty().find { it.id == id } ?: throw NotFoundException.of("Node", id)
            }
            if (only != null && only.effectiveType() !in setOf(NodeType.HTTP, NodeType.TCP, NodeType.SET, NodeType.IF, NodeType.ASSERT, NodeType.TRANSFORM))
                throw BadRequestException("이 노드는 단독 실행을 지원하지 않습니다.")
            val selected = only?.let { listOf(it) } ?: graph.nodesOrEmpty()
            if (workspace.localRuntime && selected.any { it.effectiveType() == NodeType.TRANSFORM })
                throw BadRequestException("플러그인은 공용·팀 워크스페이스에서만 사용할 수 있습니다.")
            if (device == "server" && selected.any { it.effectiveType() != NodeType.TRANSFORM && it.executionAgent == "local" })
                throw BadRequestException("내 PC 노드가 있는 실행은 Windows 앱에서 시작하세요.")
            if (workspace.localRuntime && selected.any { it.executionAgent == "server" } && account?.connected != true)
                throw BadRequestException("서버 노드를 실행하려면 Windows 앱에서 서버에 로그인하세요.")
            val execution = Execution.start(tenant, flow.id, version.id, trigger, username,
                req?.input?.takeUnless { it.isNull }?.let(json::toJson), execId).apply {
                agentDeviceId = device; runRequestHash = requestHash
            }
            executionRepo.save(execution)
            val ctx = ExecutionContext().apply { workspaceId = flow.workspaceId }
            seedWorkspaceInput(ctx, req)
            val secrets = secretMap(req?.envName, flow.workspaceId)
            if (secrets.isNotEmpty()) ctx.putSeed("secret", secrets)
            if (only != null) req?.upstream?.takeIf { it.isObject }?.fields()?.forEach { (source, value) ->
                if (value.isObject && source !in setOf("secret", "env", "input")) seedScope(ctx, value, source)
            }
            graph.nodesOrEmpty().filter { it.effectiveType() == NodeType.WAIT }.forEach { node ->
                ctx.putSeed(node.id!!, mapOf("url" to FlowExecutor.receiveUrl(relayBase, execId.toString(), node.id)))
            }
            val state = flowExecutor.newRun(graph, ctx, relayBase, execId.toString())
            state.configureAgentRun(AgentRunOptions(execId, device, owner, username, flow.workspaceId?.toString() ?: "public", req?.envName,
                account?.serverUrl, account?.login, req?.agentDependencies.orEmpty(), req?.agentEnvironments.orEmpty()), only?.id)
            val outcome = flowExecutor.execute(state, recorder(execId, secrets.values, state))
            settleManaged(execution, outcome, state)
            if (workspace.localRuntime && execution.status == ExecutionStatus.WAITING)
                afterCommit { events.publishEvent(AgentRunStarted(execId, tenant, account?.serverUrl, account?.login)) }
            managedDetail(execution)
        }!!
    }

    /** 모든 호출자는 tx 안에서 실행한다. 다음 작업, 결과 이력, 체크포인트가 함께 commit된다. */
    private fun settleManaged(execution: Execution, initial: FlowExecutor.Outcome, state: FlowExecutor.RunState) {
        var outcome = initial
        while (outcome.pendingWait != null) {
            val nodeId = outcome.pendingWait!!.nodeId ?: break
            val callback = callbackInbox.take(execution.id, nodeId) ?: break
            val input = FlowExecutor.ResumeInput(null, null, null, null,
                FlowExecutor.ResumeInput.Callback(callback.method, callback.url, callback.headers, callback.body), null)
            outcome = flowExecutor.resume(state, input, 0, recorder(execution.id, state = state))
        }
        applyStatus(execution, outcome)
        executionRepo.save(execution)
        if (outcome.isPending()) {
            state.agentRequest?.let { request -> agentTasks.create(request, state.agentRun!!) }
            val snapshot = flowExecutor.snapshot(state)
            val deadline = outcome.pendingWait?.let { Instant.now().plusSeconds(waitSecs(it.timeoutSec)) }
            val row = suspensionRepo.findById(execution.id).orElse(null)
                ?: ExecutionSuspension.of(execution.id, execution.tenantId, snapshot.pendingNodeId!!, "", null, null)
            row.pendingNodeId = snapshot.pendingNodeId!!
            row.runState = crypto.encrypt(mapper.writeValueAsString(snapshot))
            row.outcomeJson = mapper.writeValueAsString(outcome)
            row.waitDeadline = deadline
            suspensionRepo.save(row)
            val pendingWait = outcome.pendingWait
            val pendingNode = pendingWait?.nodeId
            if (pendingNode != null) afterCommit {
                scheduler.schedule({ onWaitTimeout(execution.id, pendingNode, waitSecs(pendingWait.timeoutSec)) },
                    waitSecs(pendingWait.timeoutSec), TimeUnit.SECONDS)
            }
            outcome.pendingAgent?.takeIf { execution.agentDeviceId == "server" }?.let { pending ->
                afterCommit { worker.execute { withTenant(execution.tenantId) { agentTasks.startServerTask(pending.taskId) } } }
            }
        } else {
            suspensionRepo.deleteByExecutionId(execution.id)
            callbackInbox.clear(execution.id)
            if (execution.status == ExecutionStatus.FAILED) afterCommit {
                notifier.notifyFailure(execution.tenantId, execution.id, execution.flowId, execution.error)
            }
        }
    }

    /** commit 알림을 별도 스레드에서 처리해 이전 트랜잭션의 잠금·영속성 컨텍스트와 분리한다. */
    @EventListener
    fun agentTaskCompleted(event: AgentTaskCompleted) = queueAgentResult(event)

    private fun queueAgentResult(event: AgentTaskCompleted, attempt: Int = 0) {
        val work: () -> Unit = {
            withTenant(event.tenant) {
                try {
                    managedTx.execute {
                        val result = agentTasks.result(event.taskId) ?: return@execute
                        val row = suspensionRepo.locked(event.executionId) ?: return@execute
                        val execution = executionRepo.findByIdAndTenantId(event.executionId, event.tenant).orElseThrow()
                        if (execution.status != ExecutionStatus.WAITING) return@execute
                        val suspended = rehydrateFromRow(row) ?: throw IllegalStateException("실행 체크포인트 복원 실패")
                        if (suspended.state.agentRequest?.taskId != event.taskId) return@execute
                        val state = suspended.state
                        val scope = flowRepo.findById(execution.flowId).orElseThrow().workspaceId
                        try { workspace.requireWrite(state.agentRun!!.username, scope) }
                        catch (denied: com.flowlink.common.error.ForbiddenException) {
                            execution.markFailed("워크스페이스 실행 권한이 변경되어 실행을 중단했습니다.")
                            executionRepo.save(execution); suspensionRepo.deleteByExecutionId(execution.id)
                            callbackInbox.clear(execution.id)
                            agentTasks.markApplied(event.taskId)
                            return@execute
                        }
                        val outcome = flowExecutor.resumeAgent(state, result.result, result.durationMs,
                            recorder(execution.id, state = state))
                        settleManaged(execution, outcome, state)
                        agentTasks.markApplied(event.taskId)
                    }
                } catch (e: Exception) {
                    // 저장 실패 시 작업 결과와 체크포인트를 보존한다. 외부 I/O는 다시 호출하지 않는다.
                    log.warn("에이전트 결과 적용 보류(exec={}, task={}): {}", event.executionId, event.taskId, msg(e))
                    scheduler.schedule({ queueAgentResult(event, attempt + 1) }, minOf(60L, 2L shl minOf(attempt, 5)), TimeUnit.SECONDS)
                }
            }
        }
        try { worker.execute(work) } catch (_: RejectedExecutionException) {
            scheduler.schedule({ queueAgentResult(event, attempt + 1) }, 1, TimeUnit.SECONDS)
        }
    }

    private fun resumeManaged(executionId: UUID, tenant: String, req: ResumeRequest?): ExecutionDetail = withTenant(tenant) {
        managedTx.execute {
            // 결과 적용과 같은 task → checkpoint 잠금 순서를 지킨다.
            if (req?.aborted == true) agentTasks.cancelExecution(executionId)
            val row = suspensionRepo.locked(executionId)
            val execution = executionRepo.findByIdAndTenantId(executionId, tenant)
                .orElseThrow { NotFoundException.of("Execution", executionId) }
            if (execution.status != ExecutionStatus.WAITING || row == null) return@execute managedDetail(execution, false)
            if (req?.aborted == true) {
                execution.markCancelled(req.error ?: "사용자가 실행을 중단했습니다.")
                executionRepo.save(execution); suspensionRepo.deleteByExecutionId(executionId)
                callbackInbox.clear(executionId)
                return@execute detail(execution, null, null, null, null)
            }
            if (row.pendingNodeId != req?.nodeId) return@execute managedDetail(execution, false)
            val suspended = rehydrateFromRow(row) ?: throw IllegalStateException("실행 체크포인트 복원 실패")
            if (suspended.outcome.pendingAgent != null) throw BadRequestException("에이전트 작업의 결과는 연결된 에이전트가 전송해야 합니다.")
            val state = suspended.state
            val scope = flowRepo.findById(execution.flowId).orElseThrow().workspaceId
            workspace.requireWrite(state.agentRun!!.username, scope)
            val outcome = flowExecutor.resume(state, toResumeInput(req), req?.durationMs ?: 0,
                recorder(executionId, state = state))
            settleManaged(execution, outcome, state)
            managedDetail(execution, false)
        }!!
    }

    private fun managedDetail(execution: Execution, liveAgent: Boolean = true): ExecutionDetail {
        val outcome = if (execution.status == ExecutionStatus.WAITING) dbOutcome(execution.id, execution.tenantId) else null
        val agent = outcome?.pendingAgent?.let { if (liveAgent) agentTasks.pending(it.taskId) else it }
        return detail(execution, outcome?.pendingClient, outcome?.pendingForm, outcome?.pendingWait, outcome?.pendingInput, agent)
    }

    private fun <T> withTenant(tenant: String, block: () -> T): T {
        val previous = TenantContext.getTenantId()
        TenantContext.setTenantId(tenant)
        return try { block() } finally { TenantContext.setTenantId(previous) }
    }

    private fun afterCommit(block: () -> Unit) {
        if (TransactionSynchronizationManager.isSynchronizationActive())
            TransactionSynchronizationManager.registerSynchronization(object : TransactionSynchronization {
                override fun afterCommit() = block()
            })
        else block()
    }

    /** 워커 공통 래퍼 — TenantContext 수동 전파 + 미처리 예외는 실행 FAILED 로 마감. */
    private fun inWorker(execId: UUID, tenant: String, body: () -> Unit) {
        TenantContext.setTenantId(tenant)
        try {
            body()
        } catch (e: Throwable) {
            // Throwable — 플러그인 JAR(무샌드박스)의 LinkageError·깊은 SpEL 의 StackOverflowError 등도 잡아
            // 실행을 FAILED 로 마감한다. Exception 만 잡으면 이런 Error 에 워커 스레드가 죽고 실행이 RUNNING
            // 으로 영영 남는다([M3]). 진짜 치명적 VM 오류는 정리 후 재던져 스레드가 회수되게 한다.
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
            if (e is VirtualMachineError) throw e // OOM 등은 삼키지 않고 재던짐
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
        // 실행 실패(사용자 중단 제외) 시 설정된 웹훅으로 비동기 알림 — 무인 실행(스케줄/웹훅)에서 특히 유용.
        if (execution.status == ExecutionStatus.FAILED) {
            notifier.notifyFailure(tenant, execId, execution.flowId, execution.error)
        }
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
        // 워크스페이스 쓰기 게이트 — 재개는 임의 노드 출력 주입이 가능한 쓰기 행위(비멤버가 팀 실행을
        // 이어붙이는 것 방지). 외부 콜백은 이 경로가 아니라 recordWaitCallback(무인증 의도)으로 온다.
        flowRepo.findById(execution.flowId).ifPresent {
            workspace.requireWrite(workspace.currentUsername(), it.workspaceId)
        }
        if (execution.agentDeviceId != null) return resumeManaged(executionId, tenant, req)
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
            val execution = executionRepo.findById(executionId).orElseThrow()
            val flow = flowRepo.findById(execution.flowId).orElseThrow()
            if (!workspace.supportsWorkspace(flow.workspaceId)) throw com.flowlink.common.error.ForbiddenException("이 실행 위치에서 재개할 수 없는 워크스페이스입니다.")
            outcome = flowExecutor.resume(
                suspended.state, toResumeInput(req),
                req?.durationMs ?: 0L,
                recorder(executionId, state = suspended.state)
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
        }
        if (row != null) {
            val mem = suspensions.remove(executionId)
            mem?.future?.cancel(false)
            if (mem != null) return mem
            // 서버 재시작 후(캐시 없음) — DB 스냅샷 복호화·rehydrate. 실패하면 행은 이미 삭제됐으므로
            // 조용히 null 반환하면 실행이 영영 WAITING 으로 갇힌다 → FAILED 로 명시 마감(누수 방지, [H3]).
            return rehydrateFromRow(row) ?: run { markStranded(executionId, "재개 상태 복원 실패(암호키 교체/그래프 삭제 등)"); null }
        }
        // DB 행이 없음 — persist 실패로 캐시에만 존재할 수 있다(같은 인스턴스 한정 폴백, [H2]).
        // pendingNodeId 일치 확인 후 원자적 map 제거로 승자 판정.
        val mem = suspensions[executionId] ?: return null
        if (mem.state.pendingNodeId != nodeId) return null
        if (!suspensions.remove(executionId, mem)) return null // 다른 경쟁자가 먼저 가져감
        mem.future?.cancel(false)
        return mem
    }

    /** claim 은 성공했으나 상태 복원이 불가능한 실행 — WAITING 방치 대신 FAILED 로 마감(별도 tx). */
    private fun markStranded(execId: UUID, reason: String) {
        try {
            tx.execute {
                executionRepo.findById(execId).ifPresent { ex ->
                    if (ex.status == ExecutionStatus.RUNNING || ex.status == ExecutionStatus.WAITING) {
                        ex.markFailed(reason)
                        executionRepo.save(ex)
                    }
                }
            }
            suspensions.remove(execId)
        } catch (e: Exception) {
            log.warn("stranded 마감 실패(exec={}): {}", execId, msg(e))
        }
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

    fun get(executionId: UUID): ExecutionDetail {
        val e = executionRepo.findByIdAndTenantId(executionId, TenantContext.getTenantId())
            .orElseThrow { NotFoundException.of("Execution", executionId) }
        requireFlowRead(e.flowId) // 실행 상세도 flow 의 워크스페이스 읽기 권한 필요
        if (e.agentDeviceId != null) return managedDetail(e)
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
        // flow 존재 확인(공유 풀) — 없는 flowId 는 404. 워크스페이스 읽기 권한도 함께.
        val flow = flowRepo.findByIdAndTenantId(flowId, TenantContext.SHARED_FLOW_TENANT)
            .orElseThrow { NotFoundException.of("Flow", flowId) }
        workspace.requireRead(workspace.currentUsername(), flow.workspaceId)
        // 실행 이력은 사용자별 격리 유지 — 공유 flow 라도 내 실행만 반환(타 팀 실행 유출 방지).
        val execs = executionRepo.findByFlowIdAndTenantIdOrderByStartedAtDesc(
            flowId, TenantContext.getTenantId(), PageRequest.of(0, clamp(limit)))
        return withFlowNames(execs)
    }

    /** 실행 이력 필터 조회(status/flowId/기간 + offset 페이지네이션 + **워크스페이스 스코프**) — 과거 실패 추적용. */
    @Transactional(readOnly = true)
    fun listFiltered(
        status: ExecutionStatus?, flowId: UUID?, fromMs: Long?, toMs: Long?, limit: Int, offset: Int,
        workspaceIdRaw: String? = null,
    ): List<ExecutionSummary> {
        // 워크스페이스별 분리 — 미지정('public'/null)=공용 스코프. 접근 권한 없는 워크스페이스는 403.
        // flowId 직접 필터면 **그 flow 의 워크스페이스**가 스코프(실행 상세 모달의 flow 이력 등 — 파라미터 불일치로 빈 결과 방지).
        val wsId = if (flowId != null) {
            val w = flowRepo.findById(flowId).orElse(null)?.workspaceId
            workspace.requireRead(workspace.currentUsername(), w)
            w
        } else {
            val w = workspace.resolveId(workspaceIdRaw)
            workspace.requireRead(workspace.currentUsername(), w)
            w
        }
        val pageSize = clamp(limit)
        val off = offset.coerceAtLeast(0)
        // 임의 offset(pageSize 배수 아님)도 정확히 건너뛰도록 off+pageSize 를 가져와 앞 off 개를 버린다
        // (구: page=off/pageSize 정수나눗셈으로 페이지 경계 내림 → 잘못된 윈도 반환하던 버그 수정).
        val fetched = executionRepo.findFiltered(
            TenantContext.getTenantId(), status, flowId,
            fromMs?.let { Instant.ofEpochMilli(it) }, toMs?.let { Instant.ofEpochMilli(it) },
            wsId, PageRequest.of(0, off + pageSize)
        )
        val execs = if (off > 0) fetched.drop(off) else fetched
        return withFlowNames(execs)
    }

    /** 실행 → 소속 flow 의 워크스페이스 읽기 게이트. flow 행이 없으면(이론상 없음) 관용 통과. */
    private fun requireFlowRead(flowId: UUID) {
        flowRepo.findById(flowId).ifPresent { workspace.requireRead(workspace.currentUsername(), it.workspaceId) }
    }

    /**
     * 실행 이력 정리(purge) — 관리 콘솔용. flowId 또는 기준 시각(이전) 조건으로 실행+노드 기록을 일괄 삭제.
     * 진행 중(RUNNING/WAITING)은 보호. 유령 트리거 사태처럼 이력이 수천 건 오염됐을 때 목록 성능 복구용.
     */
    @Transactional
    fun purgeExecutions(flowId: UUID?, before: java.time.Instant?): Int {
        if (flowId == null && before == null) {
            throw BadRequestException("flowId 또는 olderThanDays 중 하나는 지정해야 합니다(전체 삭제 방지).")
        }
        val tenant = TenantContext.getTenantId()
        val active = listOf(ExecutionStatus.RUNNING, ExecutionStatus.WAITING)
        artifactCleanup.purge(tenant, flowId, before)
        nodeExecRepo.purgeForExecutions(tenant, flowId, before, active)
        val removed = executionRepo.purge(tenant, flowId, before, active)
        log.info("실행 이력 정리 — {}건 삭제(flowId={}, before={})", removed, flowId, before)
        return removed
    }

    /**
     * 같은 조건으로 다시 실행 — 원본 실행의 flowVersion + input 을 그대로 재실행(반복 테스트/디버깅 루프).
     * 그래프가 그 사이 바뀌어도 원본이 돌던 버전으로 재현한다.
     */
    fun rerun(execId: UUID, req: RunRequest? = null): ExecutionDetail {
        val src = executionRepo.findByIdAndTenantId(execId, TenantContext.getTenantId())
            .orElseThrow { NotFoundException.of("Execution", execId) }
        val versionNo = versionRepo.findById(src.flowVersionId).map { it.versionNo }.orElse(null)
        val input = src.inputJson?.let { json.readTree(it) }
        return run(src.flowId, RunRequest(input, req?.env, req?.envName, versionNo,
            agentDeviceId = req?.agentDeviceId, clientExecutionId = req?.clientExecutionId, onlyNodeId = req?.onlyNodeId,
            agentDependencies = req?.agentDependencies.orEmpty(), agentEnvironments = req?.agentEnvironments.orEmpty()))
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
     * 요청/응답 본문은 시크릿 마스킹(SecretMasker) 후 저장한다.
     */
    /** 실행 시작 시점의 시크릿 맵(테넌트 + 활성 환경 오버레이). 실패해도 실행은 진행(빈 맵). */
    private fun secretMap(envName: String?, workspaceId: UUID?): Map<String, String> =
        secretService.activeSecrets(envName, workspaceId)

    /**
     * 재개 시 마스킹 소스 — 실행 시작 시 ctx 에 시드한 시크릿 맵(활성 환경 반영)의 값들.
     * 재개엔 RunRequest.envName 이 없으므로 재조회하지 않고 시드된 값을 그대로 읽는다.
     */
    private fun secretValuesOf(state: FlowExecutor.RunState): Collection<String> {
        val values = (state.context().raw("secret") as? Map<*, *>)?.values?.mapNotNull { it as? String }.orEmpty().toMutableList()
        for (node in state.nodes()) {
            val output = state.context().raw(node.id ?: continue) as? Map<*, *> ?: continue
            node.vars.orEmpty().filter { it.secret }.forEach { variable ->
                output[variable.key]?.let { values.add(if (it is String) it else json.toJson(it)) }
            }
        }
        return values
    }

    private fun recorder(execId: UUID, secretValues: Collection<String> = emptyList(), state: FlowExecutor.RunState? = null): NodeRecorder {
        // 마스킹 규칙은 SecretMasker(원문+URL 인코딩·JSON 이스케이프 변형, 긴 값 우선) — 단일 노드 실행 응답과 공유.
        return NodeRecorder { node, seq, result, status, durationMs ->
            val masks = SecretMasker.variants(secretValues + (state?.let(::secretValuesOf) ?: emptyList()))
            val ne = NodeExecution.of(execId, node.id!!, node.name, node.type, seq)
            ne.executionAgent = if (node.effectiveType() == NodeType.TRANSFORM) "server" else node.executionAgent ?: if (workspace.localRuntime) "local" else "server"
            val outputJson = if (result.storedValue != null) SecretMasker.mask(json.toJson(result.storedValue), masks) else null
            val requestText = SecretMasker.mask(result.requestText, masks)
            val responseText = SecretMasker.mask(result.responseText, masks)
            ne.complete(
                status, result.ok, result.httpStatus,
                requestText, responseText, outputJson, durationMs
            )
            nodeExecRepo.save(ne)
        }
    }

    // (마스킹 유틸은 SecretMasker 로 추출 — recorder·runSingleNode 가 공유)

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
            if (pw != null) pw.nodeId?.let { nodeId ->
                scheduleWaitTimeout(execId, nodeId, waitSecs(pw.timeoutSec), suspended)
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
        val req = ResumeRequest(
            nodeId, null, null,
            "콜백 대기 타임아웃 — ${secs}초 동안 콜백이 오지 않았습니다.",
            null, null, null, null, null
        )
        val execution = executionRepo.findById(execId).orElse(null) ?: return
        if (execution.agentDeviceId != null) {
            runCatching { resumeManaged(execId, execution.tenantId, req) }
                .onFailure {
                    log.warn("관리 실행 타임아웃 적용 보류(exec={}): {}", execId, msg(it))
                    scheduler.schedule({ onWaitTimeout(execId, nodeId, secs) }, 2, TimeUnit.SECONDS)
                }
            return
        }
        val claimed = claim(execId, nodeId) ?: return
        // 워커 풀로 제출 — 단일 스케줄러 스레드에서 재개 체인을 직접 돌리면 다른 타임아웃들이 줄서서 밀린다([M2]).
        submitResume(execId, claimed, req)
    }

    /**
     * 기동 복구 — ① suspension 이 있는 대기 실행의 wait 타임아웃 재무장(경과분은 즉시 발화)
     * ② suspension 없는 진행 중(RUNNING/WAITING) 고아는 FAILED 로 reconcile(크래시/재시작으로 소실된 실행).
     */
    @EventListener(ApplicationReadyEvent::class)
    fun recoverOnStartup() {
        val rows = suspensionRepo.findAll()
        for (row in rows) {
            if (workspace.localRuntime) {
                val options = rehydrateFromRow(row)?.state?.agentRun
                if (options?.ownerAgent == "local")
                    events.publishEvent(AgentRunStarted(row.executionId, row.tenantId, options.serverUrl, options.login))
            }
            val deadline = row.waitDeadline ?: continue // wait 외 pending 은 브라우저 resume 대기(타이머 없음)
            val delay = maxOf(0L, deadline.epochSecond - Instant.now().epochSecond)
            try {
                scheduler.schedule({ onWaitTimeout(row.executionId, row.pendingNodeId, delay) }, delay, TimeUnit.SECONDS)
                log.info("wait 타임아웃 재무장(exec={}, node={}, {}초 후)", row.executionId, row.pendingNodeId, delay)
            } catch (e: Exception) {
                log.warn("타임아웃 재무장 실패(exec={}): {}", row.executionId, msg(e))
            }
        }
        val alive = rows.associateBy { it.executionId }
        val inFlight = executionRepo.findByStatusIn(listOf(ExecutionStatus.RUNNING, ExecutionStatus.WAITING))
        // ① suspension 행은 있는데 status 가 RUNNING 인 실행 = 행 commit 과 상태 save 사이에 크래시([M1]).
        //    WAITING 으로 화해시켜 GET 폴링이 pending 을 다시 받고 콜백/타임아웃으로 재개되게 한다.
        var reconciled = 0
        for (e in inFlight) {
            if (e.status == ExecutionStatus.RUNNING && alive.containsKey(e.id)) {
                e.markWaiting(); executionRepo.save(e); reconciled++
            }
        }
        // ② suspension 이 없는 진행 중 실행 = 스냅샷 없이 소실된 고아 → FAILED.
        val orphans = inFlight.filter { it.id !in alive.keys && it.status != ExecutionStatus.FAILED }
        for (e in orphans) {
            e.markFailed("서버 재시작으로 중단된 실행")
            executionRepo.save(e)
        }
        if (orphans.isNotEmpty() || rows.isNotEmpty() || reconciled > 0) {
            log.info("기동 복구: suspension {}건 재무장, RUNNING→WAITING 화해 {}건, 고아 {}건 FAILED", rows.size, reconciled, orphans.size)
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
        val execution = executionRepo.findById(execId).orElse(null)
        if (execution?.agentDeviceId != null) return withTenant(execution.tenantId) {
            managedTx.execute {
                val row = suspensionRepo.locked(execId) ?: return@execute RelayResponse.plainOk()
                val current = executionRepo.findById(execId).orElseThrow()
                if (current.status != ExecutionStatus.WAITING) return@execute RelayResponse.plainOk()
                val suspended = rehydrateFromRow(row) ?: throw IllegalStateException("실행 체크포인트 복원 실패")
                val node = suspended.state.node(nodeId)
                if (node?.effectiveType() != NodeType.WAIT) return@execute RelayResponse.plainOk()
                val response = waitResponseFor(suspended.state, nodeId)
                val callback = CallbackPayload(method,
                    FlowExecutor.receiveUrl(suspended.state.relayBase, execId.toString(), nodeId), headers, bodyText)
                callbackInbox.offer(execId, nodeId, callback)
                if (suspended.outcome.pendingWait?.nodeId == nodeId)
                    settleManaged(current, suspended.outcome, suspended.state)
                response
            }!!
        }
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
        val node = state.node(nodeId)
        return RelayResponse.of(node?.callbackRespType, node?.callbackRespBody)
    }

    private fun seedWorkspaceInput(ctx: ExecutionContext, req: RunRequest?) {
        if (!environmentService.exists(req?.envName, ctx.workspaceId)) throw BadRequestException("선택한 실행 환경이 없습니다: ${req?.envName}")
        seedScope(ctx, req?.input, "input")
        val values = linkedMapOf<String, Any?>()
        values.putAll(environmentService.vars(req?.envName, ctx.workspaceId))
        req?.env?.takeIf { it.isObject }?.let { node ->
            @Suppress("UNCHECKED_CAST")
            values.putAll(mapper.convertValue(node, Map::class.java) as Map<String, Any?>)
        }
        if (values.isNotEmpty()) ctx.putOutput("env", values)
    }

    // 실행 입력(input)·선택 환경(env)의 변수 묶음을 소스 id 로 시드 → {{ key@input }} / {{ key@env }} 로 참조.
    private fun seedScope(ctx: ExecutionContext, node: JsonNode?, sourceId: String) {
        if (node == null || !node.isObject) return
        @Suppress("UNCHECKED_CAST")
        val map = mapper.convertValue(node, Map::class.java) as Map<String, Any?>
        ctx.putOutput(sourceId, map)
    }

    private fun detail(
        e: Execution,
        pending: FlowExecutor.PendingClient?,
        form: FlowExecutor.PendingForm?,
        wait: FlowExecutor.PendingWait?,
        input: FlowExecutor.PendingInput?,
        agent: PendingAgent? = null,
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
            nodes, pc, pf, pw, pi, agent
        )
    }

    private fun toView(n: NodeExecution): NodeExecutionView {
        val outputJson = n.outputJson
        val output = if (outputJson == null) null else json.readTree(outputJson)
        return NodeExecutionView(
            n.id, n.nodeId, n.nodeName, n.nodeType,
            n.seq, n.status, n.httpStatus, n.durationMs, n.isOk,
            n.requestText, n.responseText, output, n.executionAgent
        )
    }

    private fun currentUser(): String? {
        // GitHub 로그인 사용자(자체 JWT)면 JwtRoleConverter 가 name=preferred_username(없으면 sub)으로 세팅. dev 모드·게스트는 null.
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

        private fun msg(e: Throwable): String = e.message ?: e.toString()

        private fun clamp(limit: Int): Int {
            if (limit <= 0) {
                return 50
            }
            return minOf(limit, 200)
        }
    }
}
