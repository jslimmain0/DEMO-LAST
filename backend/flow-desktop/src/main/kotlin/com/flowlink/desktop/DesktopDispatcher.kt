package com.flowlink.desktop

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.agent.*
import com.flowlink.common.tenant.TenantContext
import com.flowlink.desktop.DesktopDispatchJournal.Entry
import com.flowlink.desktop.DesktopDispatchJournal.Phase
import com.flowlink.execution.ExecutionService
import com.flowlink.execution.engine.NodeResult
import jakarta.annotation.PreDestroy
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.annotation.Profile
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** 브라우저가 아닌 설치 앱이 승인된 실행만 추적하고 에이전트 작업을 전달한다. */
@Service
@Profile("desktop")
class DesktopDispatcher(
    private val session: DesktopSession,
    private val connection: DesktopConnection,
    private val journal: DesktopDispatchJournal,
    private val executions: ExecutionService,
    private val tasks: AgentTaskService,
    private val executor: AgentNodeExecutor,
    private val mapper: ObjectMapper,
    private val updateGate: com.flowlink.common.lifecycle.RuntimeUpdateGate = com.flowlink.common.lifecycle.RuntimeUpdateGate(),
) {
    private val clock = Executors.newSingleThreadScheduledExecutor { Thread(it, "desktop-dispatch-poll").apply { isDaemon = true } }
    private val worker = Executors.newFixedThreadPool(4) { Thread(it, "desktop-dispatch-node").apply { isDaemon = true } }
    private val active = ConcurrentHashMap.newKeySet<String>()
    private val log = LoggerFactory.getLogger(javaClass)
    private var pollOffset = 0

    @EventListener(ApplicationReadyEvent::class)
    fun start() { clock.scheduleWithFixedDelay(::poll, 0, 500, TimeUnit.MILLISECONDS) }

    @EventListener
    fun localStarted(event: AgentRunStarted) {
        val account = connection.view()
        val entry = Entry(event.executionId, false, event.serverUrl ?: account.serverUrl,
            if (event.serverUrl != null) event.login else account.login, tenant = event.tenant)
        if (journal.get(entry.key) == null) journal.put(entry)
    }

    @EventListener
    fun remoteStarted(event: DesktopRemoteRunStarted) {
        val entry = Entry(event.executionId, true, event.serverUrl, event.login)
        if (journal.get(entry.key) == null) journal.put(entry)
    }

    @EventListener
    fun remoteRejected(event: DesktopRemoteRunRejected) { journal.remove("remote:${event.executionId}") }

    data class View(val executionId: UUID, val remote: Boolean, val taskId: String?, val phase: Phase, val message: String?)
    fun views(): List<View> = journal.all().map { entry ->
        val account = connection.view()
        val message = if ((entry.remote || entry.delegated) &&
            (!account.connected || account.serverUrl != entry.serverUrl || account.login != entry.login))
            "실행을 시작한 서버 계정의 연결을 기다립니다." else entry.message
        View(entry.executionId, entry.remote, entry.taskId, entry.phase, message)
    }

    private fun poll() {
        try {
            val entries = journal.all()
            if (entries.isEmpty()) return
            val start = Math.floorMod(pollOffset++, entries.size)
            for (offset in entries.indices) {
                val entry = entries[(start + offset) % entries.size]
                // 동시 외부 요청은 4개로 제한한다. 각 실행은 한 워커만 처리한다.
                if (active.size >= 4) break
                if (active.add(entry.key)) worker.execute {
                    TenantContext.setTenantId(entry.tenant)
                    try { updateGate.work { journal.get(entry.key)?.let(::drive) } }
                    catch (_: Exception) {
                        // 요청 본문·시크릿이 들어갈 수 있는 예외 원문은 UI/로그에 노출하지 않는다.
                        journal.get(entry.key)?.let { current ->
                            if (current.phase != Phase.UNKNOWN && current.message == null) runCatching {
                                journal.put(current.copy(message = "에이전트 연결 또는 결과 확인을 기다립니다. 같은 작업을 유지합니다."))
                            }
                        }
                    }
                    finally { TenantContext.clear(); active.remove(entry.key) }
                }
            }
        } catch (failure: Exception) { log.warn("에이전트 작업 조회를 계속할 수 없습니다: {}", failure.javaClass.simpleName) }
    }

    private fun connected(entry: Entry): Boolean = connection.view().let {
        it.connected && it.serverUrl == entry.serverUrl && it.login == entry.login
    }

    private fun drive(entry: Entry) {
        if (entry.remote && !connected(entry)) return
        val detail = if (entry.remote) remote(entry, "GET", "/api/v1/executions/${entry.executionId}")
            else mapper.valueToTree<JsonNode>(executions.get(entry.executionId))
        if (detail.path("status").asText() in setOf("SUCCEEDED", "FAILED", "CANCELLED")) {
            if (entry.delegated && !ackDelegation(entry)) return
            journal.remove(entry.key); return
        }
        if (entry.phase == Phase.RESULT) { deliver(entry); return }
        if (entry.phase == Phase.EXECUTING) {
            journal.put(entry.copy(phase = Phase.UNKNOWN, message = "작업 결과를 기록하지 못했습니다. 자동 재실행하지 않습니다.")); return
        }
        if (entry.phase == Phase.UNKNOWN) {
            val taskId = entry.taskId?.let(UUID::fromString) ?: return
            if (entry.delegated) { continueDelegation(entry, taskId, null); return }
            if (entry.claimToken != null) originUnknown(entry, taskId, entry.claimToken)
            return
        }
        val pending = detail.path("pendingAgent")
        if (pending.isMissingNode || pending.isNull) return // WAIT/INPUT/FORM도 앱 종료 없이 원본 실행이 유지한다.
        val taskId = UUID.fromString(pending.path("taskId").asText())
        val current = if (entry.taskId != taskId.toString()) entry.copy(taskId = taskId.toString(),
            claimToken = null, remoteClaimToken = null, agent = pending.path("agent").asText(),
            delegated = false, phase = Phase.WATCHING, result = null, durationMs = 0, message = null).also(journal::put) else entry
        val task = originGet(current, taskId)
        if (task.status in setOf("RUNNING", "SUCCEEDED", "FAILED", "ACKED")) return
        if (task.status == "UNKNOWN") {
            journal.put(current.copy(phase = Phase.UNKNOWN, message = task.error ?: "처리 결과를 확인할 수 없습니다.")); return
        }
        val claimed = originClaim(current, taskId)
        val claimToken = claimed.claimToken ?: return
        check(claimed.taskId == taskId && claimed.executionId == entry.executionId && claimed.deviceId == session.deviceId &&
            claimed.agent in setOf("local", "server")) { "승인한 실행의 작업이 아닙니다." }
        val ready = current.copy(claimToken = claimToken, agent = claimed.agent, message = null).also(journal::put)
        if (!entry.remote && claimed.agent == "server") {
            continueDelegation(ready.copy(delegated = true).also(journal::put), taskId, claimed.request)
        } else if (entry.remote && claimed.agent == "local") {
            executeLocal(ready, claimed.request ?: return)
        } else {
            // 원본 프로세스의 Executor. 서버의 실행 상태가 멱등성을 소유하므로 응답 유실에는 상태만 다시 조회한다.
            originExecute(ready, taskId, claimToken)
        }
    }

    private fun executeLocal(entry: Entry, request: AgentNodeRequest) {
        check(request.executionId == entry.executionId && request.taskId.toString() == entry.taskId) { "작업 명세의 실행 ID가 다릅니다." }
        // 이 기록이 디스크에 확정된 이후에만 부작용이 있는 노드를 호출한다.
        journal.put(entry.copy(phase = Phase.EXECUTING))
        val outcome = try { executor.execute(request) } catch (_: Exception) {
            journal.put(entry.copy(phase = Phase.UNKNOWN, message = "로컬 작업 결과를 확인할 수 없습니다. 자동 재실행하지 않습니다."))
            return
        }
        val completed = entry.copy(phase = Phase.RESULT, result = mapper.valueToTree(outcome.result), durationMs = outcome.durationMs)
        journal.put(completed)
        deliver(completed)
    }

    private fun continueDelegation(entry: Entry, taskId: UUID, request: AgentNodeRequest?) {
        if (!connected(entry)) return
        var delegated = try { remoteTask(entry, "GET", "/api/v1/agent/tasks/$taskId") }
        catch (failure: DesktopRemoteException) {
            if (failure.status != 404 || request == null) throw failure
            remoteTask(entry, "POST", "/api/v1/agent/delegations", mapper.valueToTree(mapOf("deviceId" to session.deviceId, "request" to request)))
        }
        var current = entry
        if (delegated.status in setOf("PENDING", "CLAIMED")) {
            delegated = remoteTask(entry, "POST", "/api/v1/agent/tasks/$taskId/claim", mapper.valueToTree(AgentClaim(session.deviceId)))
            val token = delegated.claimToken ?: return
            current = entry.copy(remoteClaimToken = token).also(journal::put)
            delegated = remoteTask(current, "POST", "/api/v1/agent/tasks/$taskId/execute", mapper.valueToTree(AgentLease(session.deviceId, token)))
        }
        if (delegated.status == "UNKNOWN") {
            journal.put(current.copy(phase = Phase.UNKNOWN, message = delegated.error ?: "서버 작업의 처리 결과를 확인할 수 없습니다."))
            current.claimToken?.let { originUnknown(current, taskId, it) }
        } else if (delegated.status in setOf("SUCCEEDED", "FAILED", "ACKED") && delegated.result != null) {
            val result = current.copy(phase = Phase.RESULT, result = mapper.valueToTree(delegated.result), durationMs = delegated.durationMs)
            journal.put(result); deliver(result)
        }
    }

    private fun deliver(entry: Entry) {
        if (entry.remote && !connected(entry)) return
        val taskId = UUID.fromString(entry.taskId ?: return)
        val body = AgentCompletion(session.deviceId, entry.claimToken ?: return,
            mapper.treeToValue(entry.result ?: return, NodeResult::class.java), entry.durationMs)
        if (entry.remote) remote(entry, "POST", "/api/v1/agent/tasks/$taskId/result", mapper.valueToTree(body))
        else tasks.complete(taskId, body)
        if (entry.delegated && !ackDelegation(entry)) return
        journal.put(entry.copy(taskId = null, claimToken = null, remoteClaimToken = null, agent = null,
            delegated = false, phase = Phase.WATCHING, result = null, durationMs = 0, message = null))
    }

    private fun ackDelegation(entry: Entry): Boolean {
        if (!connected(entry)) return false
        val taskId = entry.taskId ?: return true
        val task = try { remoteTask(entry, "GET", "/api/v1/agent/tasks/$taskId") }
            catch (failure: DesktopRemoteException) { if (failure.status == 404) return true else throw failure }
        if (task.status == "RUNNING") return false
        val token = entry.remoteClaimToken ?: remoteTask(entry, "POST", "/api/v1/agent/tasks/$taskId/claim",
            mapper.valueToTree(AgentClaim(session.deviceId))).claimToken ?: return false
        remote(entry, "POST", "/api/v1/agent/tasks/$taskId/ack", mapper.valueToTree(AgentLease(session.deviceId, token)))
        return true
    }

    private fun originGet(entry: Entry, id: UUID): AgentTaskView = if (entry.remote)
        remoteTask(entry, "GET", "/api/v1/agent/tasks/$id") else tasks.get(id)
    private fun originClaim(entry: Entry, id: UUID): AgentTaskView = if (entry.remote)
        remoteTask(entry, "POST", "/api/v1/agent/tasks/$id/claim", mapper.valueToTree(AgentClaim(session.deviceId)))
        else tasks.claim(id, AgentClaim(session.deviceId))
    private fun originExecute(entry: Entry, id: UUID, token: String) {
        val body = AgentLease(session.deviceId, token)
        if (entry.remote) remote(entry, "POST", "/api/v1/agent/tasks/$id/execute", mapper.valueToTree(body)) else tasks.execute(id, body)
    }
    private fun originUnknown(entry: Entry, id: UUID, token: String) {
        val body = AgentUnknown(session.deviceId, token, entry.message ?: "에이전트 작업의 처리 결과를 확인할 수 없습니다.")
        if (entry.remote) remote(entry, "POST", "/api/v1/agent/tasks/$id/unknown", mapper.valueToTree(body)) else tasks.unknown(id, body)
    }
    private fun remoteTask(entry: Entry, method: String, path: String, body: JsonNode? = null): AgentTaskView =
        mapper.treeToValue(remote(entry, method, path, body), AgentTaskView::class.java)
    private fun remote(entry: Entry, method: String, path: String, body: JsonNode? = null): JsonNode =
        connection.authenticatedJson(method, path, body, entry.serverUrl, entry.login)

    @PreDestroy
    fun close() { clock.shutdownNow(); worker.shutdownNow() }
}

@RestController
@Profile("desktop")
class DesktopDispatcherController(private val dispatcher: DesktopDispatcher) {
    @GetMapping("/api/v1/desktop/dispatches") fun views() = dispatcher.views()
}
