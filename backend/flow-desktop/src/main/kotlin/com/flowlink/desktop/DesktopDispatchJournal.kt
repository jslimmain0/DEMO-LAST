package com.flowlink.desktop

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.execution.engine.StateCrypto
import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Component
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.util.UUID

/** 팀 정의나 이력을 개인 H2로 복제하지 않고, 승인된 실행과 ACK 전 결과만 암호화 보관한다. */
@Component
@Profile("desktop")
class DesktopDispatchJournal(private val session: DesktopSession, private val mapper: ObjectMapper) {
    enum class Phase { WATCHING, EXECUTING, RESULT, UNKNOWN }
    data class Entry(
        val executionId: UUID,
        val remote: Boolean,
        val serverUrl: String,
        val login: String?,
        val tenant: String = com.flowlink.common.tenant.TenantContext.DEFAULT_TENANT,
        val taskId: String? = null,
        val claimToken: String? = null,
        val remoteClaimToken: String? = null,
        val agent: String? = null,
        val delegated: Boolean = false,
        val phase: Phase = Phase.WATCHING,
        val result: JsonNode? = null,
        val durationMs: Long = 0,
        val message: String? = null,
    ) {
        @get:com.fasterxml.jackson.annotation.JsonIgnore
        val key: String get() = "${if (remote) "remote" else "local"}:$executionId"
    }

    private val file = session.directory.resolve("dispatch-journal.enc")
    private val crypto = StateCrypto(session.encryptionKey)
    private val entries: MutableMap<String, Entry> = if (Files.exists(file)) {
        mapper.readValue(crypto.decrypt(Files.readString(file)), Array<Entry>::class.java)
            .associateBy { it.key }.toMutableMap()
    } else linkedMapOf()

    init {
        // 실행 의도를 fsync한 뒤 외부 호출한다. 재시작에 의도만 남으면 재호출하지 않는다.
        entries.replaceAll { _, entry -> if (entry.phase == Phase.EXECUTING)
            entry.copy(phase = Phase.UNKNOWN, message = "앱이 종료되어 처리 결과를 확인할 수 없습니다. 자동 재실행하지 않습니다.")
            else entry }
        if (Files.exists(file)) persist()
    }

    @Synchronized fun all(): List<Entry> = entries.values.toList()
    @Synchronized fun get(key: String): Entry? = entries[key]
    @Synchronized fun put(entry: Entry) {
        val previous = entries.put(entry.key, entry)
        try { persist() } catch (failure: Exception) {
            if (previous == null) entries.remove(entry.key) else entries[entry.key] = previous
            throw failure
        }
    }
    @Synchronized fun remove(key: String) {
        val previous = entries.remove(key) ?: return
        try { persist() } catch (failure: Exception) { entries[key] = previous; throw failure }
    }

    private fun persist() {
        val temporary = Files.createTempFile(session.directory, "dispatch-", ".enc")
        try {
            DesktopSession.protect(temporary)
            val encrypted = crypto.encrypt(mapper.writeValueAsString(entries.values)).toByteArray(Charsets.UTF_8)
            FileChannel.open(temporary, StandardOpenOption.WRITE).use { channel ->
                val bytes = ByteBuffer.wrap(encrypted)
                while (bytes.hasRemaining()) channel.write(bytes)
                channel.force(true)
            }
            Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } finally { Files.deleteIfExists(temporary) }
    }
}
