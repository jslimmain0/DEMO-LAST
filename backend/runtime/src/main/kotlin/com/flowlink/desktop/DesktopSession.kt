package com.flowlink.desktop

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Component
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.AclEntry
import java.nio.file.attribute.AclEntryPermission
import java.nio.file.attribute.AclEntryType
import java.nio.file.attribute.AclEntryFlag
import java.nio.file.attribute.AclFileAttributeView
import java.nio.file.attribute.PosixFilePermission
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import jakarta.annotation.PreDestroy

/** 설치형 런타임 전용. 서버 JWT와 섞이지 않는 OS 사용자별 로컬 접근 키. */
@Component
@Profile("desktop")
class DesktopSession(
    @Value("\${flowlink.desktop.data-dir}") dataDir: String,
    @Value("\${server.port}") val port: Int,
) : AutoCloseable {
    final val directory: Path = Path.of(dataDir).toAbsolutePath().normalize().also {
        Files.createDirectories(it)
        protect(it)
    }
    private val channel = FileChannel.open(directory.resolve("agent.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE)
    private val lock = channel.tryLock() ?: error("이 개인 저장소의 에이전트가 이미 실행 중입니다.")
    final val token: String = randomToken()
    final val encryptionKey: String = persistent("storage.key") { randomToken() }
    final val deviceId: String = persistent("device.id") { UUID.randomUUID().toString() }
    val baseUrl: String get() = "http://127.0.0.1:$port"
    val cookieName: String get() = "fl-local-$port"
    private val tickets = ConcurrentHashMap<String, Long>()

    fun publish(mapper: ObjectMapper) {
        val file = Files.createTempFile(directory, "agent-", ".json")
        // 파일을 먼저 보호하고 쓴다. 서버 토큰·워크플로 시크릿은 여기에 저장하지 않는다.
        protect(file)
        Files.writeString(file, mapper.writeValueAsString(mapOf("baseUrl" to baseUrl, "token" to token, "deviceId" to deviceId)))
        Files.move(file, directory.resolve("agent.json"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }

    fun browserUrl(): String {
        val now = System.currentTimeMillis()
        tickets.entries.removeIf { it.value < now }
        val ticket = randomToken()
        tickets[ticket] = now + 30_000
        return "$baseUrl/desktop/open?ticket=$ticket"
    }

    fun claimTicket(ticket: String): Boolean = (tickets.remove(ticket) ?: 0) >= System.currentTimeMillis()

    fun accepts(value: String?): Boolean = value != null && MessageDigest.isEqual(
        token.toByteArray(Charsets.UTF_8), value.toByteArray(Charsets.UTF_8),
    )

    private fun persistent(name: String, create: () -> String): String {
        val file = directory.resolve(name)
        if (!Files.exists(file)) {
            Files.createFile(file)
            protect(file)
            Files.writeString(file, create())
        }
        protect(file)
        return Files.readString(file).trim().also { check(it.isNotEmpty()) { "개인 키 파일이 비어 있습니다: $name" } }
    }

    @PreDestroy
    override fun close() {
        lock.release()
        channel.close()
    }

    companion object {
        fun randomToken(): String = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })

        fun protect(path: Path) {
            val acl = Files.getFileAttributeView(path, AclFileAttributeView::class.java)
            if (acl != null) {
                val entry = AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(Files.getOwner(path))
                    .setPermissions(AclEntryPermission.values().toSet())
                if (Files.isDirectory(path)) entry.setFlags(AclEntryFlag.FILE_INHERIT, AclEntryFlag.DIRECTORY_INHERIT)
                acl.acl = listOf(entry.build())
            } else {
                Files.setPosixFilePermissions(path, if (Files.isDirectory(path)) setOf(
                    PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE,
                ) else setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE))
            }
        }
    }
}
