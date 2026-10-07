package com.flowlink.agent

import com.flowlink.common.crypto.CryptoProvider
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.execution.engine.NodeResult
import com.flowlink.execution.engine.ExecutionContext
import com.flowlink.execution.engine.TokenResolver
import com.flowlink.workspace.WorkspaceService
import jakarta.annotation.PreDestroy
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.ApplicationEventPublisher
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.web.bind.annotation.*
import java.time.Instant
import java.util.UUID
import com.flowlink.execution.config.BoundedVirtualExecutor
import java.util.concurrent.RejectedExecutionException

/** 작업 ID 하나에 외부 호출 한 번. 응답 유실은 저장된 결과를 조회하며 재호출하지 않는다. */
@Service
class AgentTaskService(
    private val repo: AgentTaskRepository, private val json: JsonService,
    private val crypto: CryptoProvider, private val workspace: WorkspaceService,
    private val executor: AgentNodeExecutor, private val events: ApplicationEventPublisher,
    txManager: PlatformTransactionManager,
    private val tokens: TokenResolver,
    private val executions: com.flowlink.core.repository.ExecutionRepository,
    private val checkpoints: com.flowlink.core.repository.ExecutionSuspensionRepository,
    private val updateGate: com.flowlink.common.lifecycle.RuntimeUpdateGate = com.flowlink.common.lifecycle.RuntimeUpdateGate(),
) {
    private val tx = TransactionTemplate(txManager)
    private val rejectionTx = TransactionTemplate(txManager).apply {
        propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRES_NEW
    }
    private val workers = BoundedVirtualExecutor("agent-executor-", 4, 100)

    fun create(request: AgentNodeRequest, run: AgentRunOptions): AgentTaskView =
        updateGate.work { createAllowed(request, run) }

    private fun createAllowed(request: AgentNodeRequest, run: AgentRunOptions): AgentTaskView = tx.execute {
        repo.findById(request.taskId).orElse(null)?.let { return@execute view(it) }
        val task = AgentTask().apply {
            id = request.taskId; executionId = request.executionId; tenantId = TenantContext.getTenantId()
            username = run.username; workspaceId = workspace.resolveId(run.workspaceId)
            nodeId = request.node.id?.takeIf { it.isNotBlank() } ?: throw BadRequestException("노드 ID가 필요합니다.")
            nodeName = request.node.name; agent = request.node.executionAgent!!
            deviceId = run.deviceId; requestData = crypto.encrypt(json.toJson(request))
        }
        view(repo.save(task))
    }!!

    fun delegate(body: AgentDelegation): AgentTaskView = updateGate.work { delegateAllowed(body) }

    private fun delegateAllowed(body: AgentDelegation): AgentTaskView = tx.execute {
        if (workspace.localRuntime) throw BadRequestException("서버 에이전트에서만 위임 작업을 받습니다.")
        val username = workspace.currentUsername()
        if (!workspace.isApproved(username)) throw ForbiddenException("승인된 서버 계정이 필요합니다.")
        requireDevice(body.deviceId)
        val request = body.request.copy(crossBoundary = true)
        if (request.node.executionAgent != "server") throw BadRequestException("서버 실행만 위임할 수 있습니다.")
        if ((request.values.keys + request.seeds.keys).any { it == "env" || it == "secret" })
            throw BadRequestException("환경·시크릿은 서버 에이전트에서 해석해야 합니다.")
        val scope = workspace.resolveId(request.workspaceId ?: "public")
        workspace.requireWrite(username, scope)
        val encoded = json.toJson(request)
        if (encoded.toByteArray().size > 5 * 1024 * 1024) throw BadRequestException("에이전트 입력은 5MB 이하여야 합니다.")
        repo.locked(request.taskId)?.let { existing ->
            authorize(existing)
            if (!existing.delegation || existing.deviceId != body.deviceId ||
                (existing.requestData != null && crypto.decrypt(existing.requestData!!) != encoded))
                throw BadRequestException("이미 등록된 작업 ID의 요청을 변경할 수 없습니다.")
            return@execute view(existing, lease = true)
        }
        val task = AgentTask().apply {
            id = request.taskId; executionId = request.executionId; tenantId = TenantContext.getTenantId()
            this.username = username; workspaceId = scope
            nodeId = request.node.id?.takeIf { it.isNotBlank() } ?: throw BadRequestException("노드 ID가 필요합니다."); nodeName = request.node.name
            agent = "server"; deviceId = body.deviceId; delegation = true
            requestData = crypto.encrypt(encoded); claimToken = UUID.randomUUID().toString(); status = "CLAIMED"
        }
        view(repo.save(task), lease = true)
    }!!

    fun get(id: UUID): AgentTaskView = tx.execute { view(load(id).also(::authorize)) }!!

    fun claim(id: UUID, body: AgentClaim): AgentTaskView = tx.execute {
        val task = load(id); authorize(task); device(task, body.deviceId)
        if (!hasActiveCheckpoint(task)) return@execute view(task, lease = true)
        if (task.claimToken == null) task.claimToken = UUID.randomUUID().toString()
        if (task.status == "PENDING") task.status = "CLAIMED"
        view(task, lease = true, packet = true)
    }!!

    fun execute(id: UUID, body: AgentLease): AgentTaskView = tx.execute {
        val task = load(id); authorize(task); lease(task, body)
        if (task.agent != executor.runtime) throw BadRequestException("이 작업은 ${task.agent} 에이전트에서 실행해야 합니다.")
        start(task)
        view(task)
    }!!

    fun complete(id: UUID, body: AgentCompletion): AgentTaskView = tx.execute {
        val task = load(id); authorize(task); lease(task, AgentLease(body.deviceId, body.claimToken))
        if (!workspace.localRuntime && task.agent != "local") throw ForbiddenException("서버 작업의 결과는 서버 실행기가 기록합니다.")
        val result = if (task.status in TERMINAL || task.status == "ACKED") body.result else {
            if (json.toJson(body.result).toByteArray(Charsets.UTF_8).size > 21 * 1024 * 1024)
                throw BadRequestException("에이전트 결과는 21MB 이하여야 합니다.")
            val request = decodeRequest(task)
            if (request.crossBoundary) {
                fun selected(value: Any?, keys: List<String>): Map<String, Any?> {
                    val ctx = ExecutionContext().apply { putOutput("result", value) }
                    return keys.associateWith { tokens.resolveTokenObject(it, false, "result", ctx) }
                }
                val output = selected(body.result.value, request.allowedOutputs)
                if (request.node.type == "if" && body.result.ok && body.result.branch !in setOf("true", "false"))
                    throw BadRequestException("IF 작업의 분기 결과가 올바르지 않습니다.")
                body.result.copy(value = output, storedValue = output,
                    reqValues = selected(body.result.reqValues, request.allowedRequestKeys),
                    requestText = "${request.node.type} · ${task.agent} 에이전트",
                    responseText = AgentResultText.response(body.result.value, output, json), branch = if (request.node.type == "if") body.result.branch else null)
            } else body.result
        }
        finish(task, AgentNodeResult(result, body.durationMs))
        view(task)
    }!!

    fun unknown(id: UUID, body: AgentUnknown): AgentTaskView = tx.execute {
        val task = load(id); authorize(task); lease(task, AgentLease(body.deviceId, body.claimToken))
        if (task.status !in TERMINAL && task.status != "ACKED") {
            task.status = "UNKNOWN"; task.error = "요청의 처리 결과를 확인할 수 없습니다. 자동 재실행하지 않습니다."
            task.updatedAt = Instant.now()
        }
        view(task)
    }!!

    fun ack(id: UUID, body: AgentLease): AgentTaskView = tx.execute {
        val task = load(id); authorize(task); lease(task, body)
        if (!task.delegation) throw BadRequestException("원본 실행 작업은 실행 엔진이 확인합니다.")
        if (task.status == "RUNNING") throw BadRequestException("실행 중인 작업은 결과를 확인한 후 정리할 수 있습니다.")
        task.status = "ACKED"; task.requestData = null; task.resultData = null; task.updatedAt = Instant.now()
        view(task)
    }!!

    /** 아래 메서드는 실행 소유 서비스 전용이며 사용자·워크스페이스는 실행 시작 시 검증한다. */
    fun pending(id: UUID): PendingAgent = tx.execute {
        val t = load(id)
        PendingAgent(t.id, t.nodeId, t.nodeName, t.agent, t.status, t.error, t.deviceId)
    }!!
    fun result(id: UUID): AgentNodeResult? = tx.execute {
        val t = load(id)
        if (t.status in TERMINAL && t.resultData != null) AgentNodeResult(decodeResult(t), t.durationMs) else null
    }
    fun markApplied(id: UUID) { tx.execute {
        val task = load(id); task.status = "ACKED"; task.requestData = null; task.resultData = null; task.updatedAt = Instant.now()
    } }
    fun cancelExecution(id: UUID) { tx.execute {
        repo.findByExecutionId(id).filter { !it.delegation }.forEach {
            val task = load(it.id); task.status = "ACKED"; task.requestData = null; task.resultData = null; task.updatedAt = Instant.now()
        }
    } }
    fun startServerTask(id: UUID) = updateGate.work { startServerTaskAllowed(id) }
    private fun startServerTaskAllowed(id: UUID) { tx.execute {
        val task = load(id)
        if (task.deviceId == "server" && task.agent == executor.runtime) start(task)
    } }

    private fun hasActiveCheckpoint(task: AgentTask): Boolean {
        if (!task.delegation) {
            // 결과 적용·취소와 같은 task → checkpoint 잠금 순서. 취소 중 새로 만들어진 작업도 차단한다.
            val checkpoint = checkpoints.locked(task.executionId)
            val execution = executions.findByIdAndTenantId(task.executionId, task.tenantId).orElse(null)
            val pendingId = checkpoint?.outcomeJson?.let { json.readTree(it).path("pendingAgent").path("taskId").asText() }
            if (execution?.status != com.flowlink.core.domain.ExecutionStatus.WAITING || pendingId != task.id.toString()) {
                task.status = "ACKED"; task.requestData = null; task.resultData = null; task.updatedAt = Instant.now()
                return false
            }
        }
        return true
    }

    private fun start(task: AgentTask) {
        if (task.status !in setOf("PENDING", "CLAIMED")) return
        if (!hasActiveCheckpoint(task)) return
        if (!workspace.supportsWorkspace(task.workspaceId)) throw ForbiddenException("작업 워크스페이스가 실행 위치와 다릅니다.")
        workspace.requireWrite(task.username, task.workspaceId)
        if (!workspace.localRuntime) {
            val target = workspace.resolveId(decodeRequest(task).workspaceId ?: "public")
            if (!workspace.supportsWorkspace(target)) throw ForbiddenException("실행 대상 워크스페이스를 사용할 수 없습니다.")
            workspace.requireWrite(task.username, target)
        }
        task.status = "RUNNING"; task.updatedAt = Instant.now()
        val id = task.id; val tenant = task.tenantId
        afterCommit { try { workers.execute {
            TenantContext.setTenantId(tenant)
            try {
                val request = tx.execute { load(id).let { if (it.status == "RUNNING") decodeRequest(it) else null } } ?: return@execute
                val outcome = executor.execute(request)
                tx.execute { finish(load(id), outcome) }
            } catch (_: Exception) {
                tx.execute { load(id).let {
                    if (it.status == "RUNNING") { it.status = "UNKNOWN"; it.error = "에이전트 결과 저장을 확인할 수 없습니다. 자동 재실행하지 않습니다." }
                } }
            } finally { TenantContext.clear() }
        } } catch (_: RejectedExecutionException) {
            // 외부 호출 전 거절이므로 UNKNOWN 대신 명시 실패. 완료 이벤트로 원본 실행도 종료한다.
            rejectionTx.execute { load(id).let {
                if (it.status == "RUNNING") finish(it, AgentNodeResult(NodeResult.fail(429, null, "에이전트 실행 대기가 가득 차 요청을 시작하지 않았습니다."), 0))
            } }
        } }
    }

    private fun finish(task: AgentTask, outcome: AgentNodeResult) {
        if (task.status == "ACKED") return
        if (task.status !in TERMINAL) {
            if (task.status == "PENDING") throw BadRequestException("작업을 먼저 확보하세요.")
            task.durationMs = outcome.durationMs.coerceAtLeast(0)
            if (outcome.result.uncertain) {
                task.status = "UNKNOWN"; task.error = "외부 요청의 처리 여부를 확인할 수 없습니다. 자동 재실행하지 않습니다."
                return
            }
            task.resultData = crypto.encrypt(json.toJson(outcome.result))
            task.status = if (outcome.result.ok) "SUCCEEDED" else "FAILED"
            task.updatedAt = Instant.now()
        }
        if (!task.delegation) {
            val event = AgentTaskCompleted(task.id, task.executionId, task.tenantId)
            afterCommit { events.publishEvent(event) }
        }
    }

    @EventListener(ApplicationReadyEvent::class)
    fun recover() {
        repo.findByStatusIn(listOf("RUNNING", "SUCCEEDED", "FAILED", "PENDING", "CLAIMED")).forEach { row ->
            TenantContext.setTenantId(row.tenantId)
            try { tx.execute {
                val t = load(row.id)
                if (t.status == "RUNNING") { t.status = "UNKNOWN"; t.error = "실행 중 에이전트가 재시작되었습니다. 처리 결과 확인이 필요합니다." }
                else if (t.status in TERMINAL && !t.delegation) {
                    afterCommit { events.publishEvent(AgentTaskCompleted(t.id, t.executionId, t.tenantId)) }
                } else if (t.deviceId == "server" && t.agent == executor.runtime) start(t)
            } } finally { TenantContext.clear() }
        }
    }

    private fun authorize(task: AgentTask) {
        if (workspace.currentUsername() != task.username) throw ForbiddenException("실행을 시작한 계정으로 연결하세요.")
        if (!workspace.localRuntime && !workspace.isApproved(task.username)) throw ForbiddenException("승인된 계정이 필요합니다.")
        workspace.requireWrite(task.username, task.workspaceId)
    }
    private fun requireDevice(id: String) { if (id.isBlank() || id.length > 100 || id == "server") throw BadRequestException("올바른 PC 에이전트 ID가 필요합니다.") }
    private fun device(task: AgentTask, id: String) { if (task.deviceId != id) throw ForbiddenException("실행을 시작한 PC에서만 작업을 처리할 수 있습니다.") }
    private fun lease(task: AgentTask, lease: AgentLease) {
        device(task, lease.deviceId)
        if (task.claimToken == null || task.claimToken != lease.claimToken) throw ForbiddenException("유효한 작업 확인 토큰이 필요합니다.")
    }
    private fun load(id: UUID): AgentTask = repo.locked(id)?.takeIf { it.tenantId == TenantContext.getTenantId() }
        ?: throw NotFoundException.of("AgentTask", id)
    private fun decodeRequest(t: AgentTask): AgentNodeRequest = json.mapper().readValue(crypto.decrypt(t.requestData!!), AgentNodeRequest::class.java)
    private fun decodeResult(t: AgentTask): NodeResult = json.mapper().readValue(crypto.decrypt(t.resultData!!), NodeResult::class.java)
    private fun view(t: AgentTask, lease: Boolean = false, packet: Boolean = false): AgentTaskView = AgentTaskView(
        t.id, t.executionId, t.nodeId, t.agent, t.status, t.deviceId, t.error,
        if (packet && t.requestData != null && t.agent != executor.runtime) decodeRequest(t) else null,
        if (lease) t.claimToken else null,
        if (t.resultData != null && t.delegation) decodeResult(t) else null, t.durationMs,
    )
    private fun afterCommit(action: () -> Unit) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) TransactionSynchronizationManager.registerSynchronization(object : TransactionSynchronization {
            override fun afterCommit() = action()
        }) else action()
    }
    @PreDestroy fun close() { workers.shutdownNow() }
    companion object { private val TERMINAL = setOf("SUCCEEDED", "FAILED") }
}

@RestController
@RequestMapping("/api/v1/agent")
class AgentTaskController(private val service: AgentTaskService) {
    @PostMapping("/delegations") fun delegate(@RequestBody body: AgentDelegation) = service.delegate(body)
    @GetMapping("/tasks/{id}") fun get(@PathVariable id: UUID) = service.get(id)
    @PostMapping("/tasks/{id}/claim") fun claim(@PathVariable id: UUID, @RequestBody body: AgentClaim) = service.claim(id, body)
    @PostMapping("/tasks/{id}/execute") fun execute(@PathVariable id: UUID, @RequestBody body: AgentLease) = service.execute(id, body)
    @PostMapping("/tasks/{id}/result") fun result(@PathVariable id: UUID, @RequestBody body: AgentCompletion) = service.complete(id, body)
    @PostMapping("/tasks/{id}/unknown") fun unknown(@PathVariable id: UUID, @RequestBody body: AgentUnknown) = service.unknown(id, body)
    @PostMapping("/tasks/{id}/ack") fun ack(@PathVariable id: UUID, @RequestBody body: AgentLease) = service.ack(id, body)
}
