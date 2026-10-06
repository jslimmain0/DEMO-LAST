package com.flowlink.mock

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.core.domain.MockServer
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.protocol.ProtocolChangedEvent
import com.flowlink.protocol.ProtocolService
import com.flowlink.workspace.WorkspaceService
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import org.springframework.transaction.event.TransactionPhase
import org.springframework.transaction.event.TransactionalEventListener
import java.util.UUID

/** 관리 저장소·예약·커밋 이벤트와 실제 소켓 런타임의 경계. 기존 관리 API 계약 유지. */
@Component
class TcpMockRegistry(
    private val json: JsonService,
    private val repository: MockServerRepository,
    private val protocols: ProtocolService,
    private val workspace: WorkspaceService,
    private val runtime: TcpMockListenerRuntime,
    @org.springframework.beans.factory.annotation.Value("\${flowlink.mock.tcp.port-start:9091}") private val portStart: Int = 9091,
    @org.springframework.beans.factory.annotation.Value("\${flowlink.mock.tcp.port-end:9190}") private val portEnd: Int = 9190,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    fun listeningPort(id: UUID) = runtime.listeningPort(id)
    fun bindFailure(id: UUID) = runtime.bindFailure(id)
    fun stop(id: UUID) = runtime.stop(id)
    fun stopAll() = runtime.stopAll()
    fun effectiveBindAddress() = if (workspace.localRuntime) "127.0.0.1" else runtime.effectiveBindAddress()

    @EventListener(ApplicationReadyEvent::class)
    @org.springframework.core.annotation.Order(10)
    fun startAll() {
        for (m in repository.findAll()) try { sync(m) } catch (e: Exception) {
            log.warn("TCP mock 기동 실패(slug={}): {}", m.slug, e.message)
            runtime.recordFailure(m.id, e.message ?: "바인딩 실패")
        }
    }
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    fun onProtocolChanged(e: ProtocolChangedEvent) = runtime.onProtocolChanged(e.id, e.spec)

    @Synchronized fun sync(m: MockServer) {
        val spec = parseSpecQuiet(m.specJson)
        val tcp = spec?.tcp
        if (workspace.supportsWorkspace(m.workspaceId)) tcp?.port?.let { port ->
            validatePort(port)
            if (repository.findAll().any { it.id != m.id && workspace.supportsWorkspace(it.workspaceId) && parseSpecQuiet(it.specJson)?.tcp?.port == port }) throw BadRequestException("TCP 포트 $port 는 다른 Mock에 할당되어 있습니다.")
        }
        val want = workspace.supportsWorkspace(m.workspaceId) && m.isEnabled && tcp != null && tcp.port != null && !tcp.protocolId.isNullOrBlank()
        if (!want) { runtime.stop(m.id); return }
        validatePort(tcp!!.port!!)
        val proto = try { protocols.specOf(UUID.fromString(tcp.protocolId!!.trim()), m.tenantId, m.workspaceId) }
            catch (e: Exception) { throw BadRequestException("TCP Mock 의 프로토콜을 찾을 수 없습니다: ${tcp.protocolId}") }
        runtime.sync(m.servingSnapshot(), tcp, proto, spec!!.environment)
    }
    fun validatePort(port: Int) {
        val range = if (workspace.localRuntime) 1024..65535 else portStart..portEnd
        if (port !in range) throw BadRequestException("TCP 포트는 이 에이전트의 허용 범위 ${range.first}~${range.last} 안에서 선택하세요: $port")
    }
    @Synchronized fun pickFreePort(start: Int = if (workspace.localRuntime) 9510 else portStart): Int {
        val used = runtime.listeningPorts().toMutableSet()
        repository.findAll().filter { workspace.supportsWorkspace(it.workspaceId) }.forEach { m -> parseSpecQuiet(m.specJson)?.tcp?.port?.let { used.add(it) } }
        val end = if (workspace.localRuntime) 65535 else portEnd
        for (p in start.coerceAtLeast(if (workspace.localRuntime) 1024 else portStart)..end) if (p !in used && runtime.canBind(p)) return p
        throw BadRequestException("사용 가능한 TCP Mock 포트가 없습니다($start~$end).")
    }
    private fun parseSpecQuiet(raw: String?): MockSpec? = if (raw.isNullOrBlank()) null else try { json.mapper().readValue(raw, MockSpec::class.java) } catch (_: Exception) { null }
}
