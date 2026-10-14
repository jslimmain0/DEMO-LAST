package com.flowlink.protocol

import java.io.IOException
import java.util.UUID

/** 연결은 인증된 실행 소유자·목적지·전문 버전에 묶고, 실패/만료한 연결로 요청을 다시 보내지 않는다. */
class TcpSessionRegistry(private val idleMs: Long = 30_000, private val maxEntries: Int = 256) : AutoCloseable {
    companion object {
        const val RUN_CLOSED = "종료된 실행의 TCP 요청은 보내지 않았습니다. 새 실행을 시작하세요."
        const val IDLE_EXPIRED = "이 실행의 TCP 연결이 종료되거나 만료되었습니다. 연결 상태를 확인하고 새 실행을 시작하세요. 요청은 재전송하지 않았습니다."
        const val CAPACITY = "유지 중인 TCP 연결이 상한에 도달해 요청을 보내지 않았습니다. 기존 실행을 종료한 뒤 다시 실행하세요."
        const val SEND_CANCELLED = "실행이 종료되어 요청을 보내지 않았습니다."
        fun safeFailure(message: String?): String? = message?.takeIf { it in setOf(RUN_CLOSED, IDLE_EXPIRED, CAPACITY, SEND_CANCELLED) }
    }
    class NotSentException(message: String) : IOException(message)
    data class Scope(val executionId: UUID, val tenant: String, val owner: List<String>, val workspace: String?, val server: String?, val login: String?)
    private data class ClosedRun(val id: UUID, val tenant: String, val owner: List<String>?)
    private data class Key(val scope: Scope, val host: String, val port: Int, val fingerprint: String)
    private class Entry(val session: TcpClient.Session, val idleMs: Long) { @Volatile var touched = System.nanoTime(); val uses = java.util.concurrent.atomic.AtomicInteger() }
    data class Result(val exchange: TcpClient.Exchange, val reused: Boolean)
    private val entries = LinkedHashMap<Key, Entry>()
    private val closedRuns = LinkedHashMap<ClosedRun, Long>()
    private var closed = false

    fun exchange(scope: Scope, host: String, port: Int, timeoutMs: Int, request: ByteArray, spec: ProtocolSpec, fingerprint: String, canSend: () -> Boolean = { true }, plugins: ProtocolCodec.PluginLookup = ProtocolCodec.NO_PLUGINS, resolve: (String) -> String = { it }): Result {
        val key = Key(scope, host, port, fingerprint)
        val (entry, reused) = synchronized(entries) {
            expireIdleLocked()
            if (closed || !canSend() || closedRuns.keys.any { it.id == scope.executionId && it.tenant == scope.tenant && (it.owner == null || it.owner == scope.owner) })
                throw NotSentException(RUN_CLOSED)
            val old = entries[key]
            if (old != null) {
                if (old.session.isClosed) throw NotSentException(IDLE_EXPIRED)
                old.uses.incrementAndGet()
                old to true
            } else {
                if (entries.size >= maxEntries) throw NotSentException(CAPACITY)
                Entry(TcpClient.Session(host, port, timeoutMs), spec.transport?.idleTimeoutMs?.toLong() ?: idleMs).also { it.uses.incrementAndGet(); entries[key] = it } to false
            }
        }
        synchronized(entry) {
            try { return Result(entry.session.exchange(request, spec, timeoutMs, canSend, plugins, resolve), reused) }
            finally { entry.touched = System.nanoTime(); entry.uses.decrementAndGet() }
        }
    }

    fun expireIdle() = synchronized(entries) { expireIdleLocked() }
    private fun expireIdleLocked() {
        val now = System.nanoTime()
        // shortcut: 종료 차단 기록은 최근 1시간/4096개; 관리 작업은 송신 직전 DB 상태도 확인한다.
        closedRuns.entries.removeIf { (now - it.value) / 1_000_000 >= 3_600_000 }
        entries.values.filter { it.uses.get() == 0 && (now - it.touched) / 1_000_000 >= it.idleMs }.forEach { it.session.close() }
    }

    fun closeScope(scope: Scope) = synchronized(entries) {
        entries.entries.filter { it.key.scope == scope }.map { it.key }.forEach { entries.remove(it)?.session?.close() }
    }
    fun invalidateExecution(executionId: UUID, tenant: String, owner: List<String>? = null) = synchronized(entries) {
        blockExecution(executionId, tenant, owner)
        entries.filter { it.key.scope.executionId == executionId && it.key.scope.tenant == tenant && (owner == null || it.key.scope.owner == owner) }.values.forEach { it.session.close() }
    }
    fun closeExecution(executionId: UUID, tenant: String, owner: List<String>? = null) = synchronized(entries) {
        blockExecution(executionId, tenant, owner)
        entries.keys.filter { it.scope.executionId == executionId && it.scope.tenant == tenant && (owner == null || it.scope.owner == owner) }
            .forEach { entries.remove(it)?.session?.close() }
    }
    private fun blockExecution(id: UUID, tenant: String, owner: List<String>?) {
        closedRuns[ClosedRun(id, tenant, owner)] = System.nanoTime()
        while (closedRuns.size > 4096) closedRuns.remove(closedRuns.keys.first())
    }
    override fun close() = synchronized(entries) { closed = true; entries.values.forEach { it.session.close() }; entries.clear(); closedRuns.clear() }
}
