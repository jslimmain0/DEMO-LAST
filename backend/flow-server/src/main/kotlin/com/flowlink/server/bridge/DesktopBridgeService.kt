package com.flowlink.server.bridge

import com.flowlink.common.bridge.*
import org.springframework.stereotype.Service
import org.springframework.http.HttpStatus
import org.springframework.web.server.ResponseStatusException
import java.util.UUID
import java.security.SecureRandom
import java.util.Base64

/** Bounded transient relay. Personal resources never become team entities or long-lived server records. */
@Service
class DesktopBridgeService {
    private data class Session(val user: String, val device: String, val id: String, val secret: String, var seen: Long)
    private data class Entry(val user: String, val device: String, val session: String, val command: DesktopCommand, val created: Long, var result: DesktopCommandResult)
    private val sessions = mutableMapOf<String, Session>()
    private val entries = linkedMapOf<UUID, Entry>()
    private fun now() = System.currentTimeMillis()
    @org.springframework.scheduling.annotation.Scheduled(fixedDelay = 60_000)
    @Synchronized fun prune() {
        val time = now()
        entries.values.filter { time - it.created > 600_000 && it.result.status in setOf("PENDING", "RUNNING") }.forEach { it.result = DesktopCommandResult(it.command.requestId, "UNKNOWN", message = "작업 확인 시간이 지났습니다. PC에서 처리 여부를 확인하세요.") }
        entries.entries.removeIf { time - it.value.created > 3_600_000 }
    }
    private fun fail(message: String): Nothing = throw ResponseStatusException(HttpStatus.CONFLICT, message)
    private fun token() = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })
    @Synchronized fun connect(user: String, device: String): DesktopBridgeSession {
        require(device.length in 1..100)
        val previous = sessions[user]
        if (previous != null && previous.device != device && now() - previous.seen < 15_000) fail("현재 연결된 PC가 있습니다. 기존 PC 연결을 종료한 후 연결하세요.")
        if (previous != null) entries.values.filter { it.session == previous.id && it.result.status in setOf("PENDING", "RUNNING") }.forEach { it.result = DesktopCommandResult(it.command.requestId, "UNKNOWN", message = "PC 연결 세션이 변경되었습니다. 처리 여부를 확인하세요.") }
        val session = Session(user, device, UUID.randomUUID().toString(), token(), now())
        sessions[user] = session
        return DesktopBridgeSession(session.id, session.secret)
    }
    private fun session(user: String, id: String, secret: String): Session {
        val active = sessions[user] ?: fail("PC 연결이 없습니다.")
        if (active.id != id || !java.security.MessageDigest.isEqual(active.secret.toByteArray(), secret.toByteArray())) throw ResponseStatusException(HttpStatus.FORBIDDEN, "PC 연결 세션이 일치하지 않습니다.")
        active.seen = now(); return active
    }
    @Synchronized fun status(user: String): Map<String, Any?> {
        val pc = sessions[user]
        return mapOf("online" to (pc != null && now() - pc.seen < 15_000), "deviceId" to pc?.device)
    }
    private fun requireDevice(user: String, device: String?) {
        if (device != null && sessions[user]?.device != device) fail("MCP 연결을 설정한 PC가 연결되어 있지 않습니다. 해당 PC의 Windows 앱에서 다시 연결하세요.")
    }
    @Synchronized fun submit(user: String, command: DesktopCommand, device: String? = null): DesktopCommandResult {
        prune()
        DesktopCommandPolicy.validate(command)
        requireDevice(user, device)
        entries[command.requestId]?.let {
            if (it.user != user || it.command != command) throw ResponseStatusException(HttpStatus.CONFLICT, "요청 ID가 다른 작업에 사용되었습니다.")
            if (device != null && it.device != device) fail("다른 PC에서 접수된 개인 작업입니다.")
            return it.result
        }
        val pc = sessions[user]?.takeIf { now() - it.seen < 15_000 } ?: fail("Windows 앱이 오프라인입니다. 같은 회사 계정으로 앱을 연결하세요.")
        entries.entries.removeIf { now() - it.value.created > 3_600_000 && it.value.result.status !in setOf("PENDING", "RUNNING") }
        if (entries.size >= 500 || entries.values.count { it.user == user && it.result.status in setOf("PENDING", "RUNNING") } >= 20) fail("처리 대기 작업이 많습니다. 기존 작업을 확인하세요.")
        val result = DesktopCommandResult(command.requestId, "PENDING")
        entries[command.requestId] = Entry(user, pc.device, pc.id, command, now(), result)
        return result
    }
    @Synchronized fun poll(user: String, id: String, secret: String): List<DesktopCommand> {
        session(user, id, secret)
        val commands = entries.values.filter { it.user == user && it.session == id && it.result.status == "PENDING" }.take(4)
        commands.forEach { it.result = DesktopCommandResult(it.command.requestId, "RUNNING") }
        return commands.map { it.command }
    }
    @Synchronized fun complete(user: String, id: String, secret: String, result: DesktopCommandResult) {
        session(user, id, secret)
        val entry = entries[result.requestId] ?: throw ResponseStatusException(HttpStatus.NOT_FOUND)
        if (entry.user != user || entry.session != id) throw ResponseStatusException(HttpStatus.FORBIDDEN)
        require(result.status in setOf("SUCCEEDED", "FAILED", "UNKNOWN"))
        require((result.body?.toString()?.toByteArray(Charsets.UTF_8)?.size ?: 0) <= DesktopCommandPolicy.MAX_BYTES)
        if (entry.result.status == "RUNNING") entry.result = result
    }
    @Synchronized fun result(user: String, requestId: UUID, device: String? = null): DesktopCommandResult {
        prune()
        val entry = entries[requestId]?.takeIf { it.user == user } ?: throw ResponseStatusException(HttpStatus.NOT_FOUND)
        requireDevice(user, device)
        if (device != null && entry.device != device) fail("다른 PC에서 접수된 개인 작업입니다.")
        if (entry.result.status == "RUNNING" && sessions[user]?.let { it.id == entry.session && now() - it.seen < 15_000 } != true) return DesktopCommandResult(requestId, "UNKNOWN", message = "PC의 작업 완료 여부를 확인할 수 없습니다. 자동으로 다시 실행하지 않습니다.")
        return entry.result
    }
}
