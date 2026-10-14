package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.agent.AgentTaskRepository
import com.flowlink.common.lifecycle.RuntimeUpdateGate
import com.flowlink.common.release.ReleaseVersion
import com.flowlink.core.repository.ExecutionRepository
import com.flowlink.execution.engine.StateCrypto
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.mockito.Mockito.mock
import org.springframework.context.ApplicationEventPublisher
import org.springframework.context.ConfigurableApplicationContext
import java.nio.file.Files
import java.nio.file.Path

/** 설치 결과만 합성한다. 실제 MSI, 사용자 앱, 서버 계정, IDE 설정에는 접근하지 않는다. */
class DesktopUpdateRecoveryTest {
    @TempDir lateinit var directory: Path
    private val mapper = jacksonObjectMapper()

    private fun service(session: DesktopSession, connection: DesktopConnection) = DesktopUpdateService(
        session, connection, mapper, RuntimeUpdateGate(), mock(ExecutionRepository::class.java),
        mock(AgentTaskRepository::class.java), mock(DesktopDispatcher::class.java), mock(ConfigurableApplicationContext::class.java))

    private fun login(session: DesktopSession) {
        Files.writeString(session.directory.resolve("server-session.enc"), StateCrypto(session.encryptionKey).encrypt(
            mapper.writeValueAsString(DesktopConnection.State("https://company.example", "https://company.example/mcp", "fixture", "synthetic-company-token"))))
    }

    private fun receipt(session: DesktopSession, phase: String, exitCode: Int, target: String = ReleaseVersion.version,
                        resultTarget: String = target, committed: Boolean = true): Path {
        val path = session.directory.resolve("updates/install-1234567890000")
        Files.createDirectories(path)
        Files.writeString(path.resolve("request.json"), mapper.writeValueAsString(mapOf("targetVersion" to target)))
        Files.writeString(path.resolve("result.json"), "\uFEFF" + mapper.writeValueAsString(mapOf("phase" to phase, "exitCode" to exitCode, "targetVersion" to resultTarget)))
        if (committed) Files.writeString(path.resolve("commit"), "install")
        return path
    }

    @Test fun `confirmed install logs out once before ready and leaves personal files and keys intact`() {
        for ((phase, code) in listOf("installed" to 0, "reboot-required" to 3010)) {
            DesktopSession(directory.resolve(phase).toString(), 18182).use { session ->
                login(session)
                val personal = session.directory.resolve("flowlink.mv.db")
                Files.writeString(personal, "synthetic personal data including AI settings")
                val preserved = listOf(personal, session.directory.resolve("storage.key"), session.directory.resolve("device.id"))
                    .associateWith(Files::readAllBytes)
                var disconnects = 0
                val events = ApplicationEventPublisher { if (it is DesktopServerDisconnected) disconnects++ }
                val connection = DesktopConnection(session, mapper, events)
                assertTrue(connection.view().connected)
                val path = receipt(session, phase, code)
                val updates = service(session, connection)
                try {
                    assertFalse(connection.view().connected)
                    assertNull(connection.view().login)
                    assertEquals("https://company.example", connection.view().serverUrl)
                    assertTrue(updates.view().loginRequired)
                    assertEquals("current", updates.view().phase)
                    assertEquals(1, disconnects, "normal logout event drives the existing MCP cleanup")
                    assertEquals(ReleaseVersion.version, Files.readString(path.resolve("handled")))
                    preserved.forEach { (file, bytes) -> assertArrayEquals(bytes, Files.readAllBytes(file)) }
                } finally { updates.close() }
                login(session)
                val newConnection = DesktopConnection(session, mapper, events)
                val restarted = service(session, newConnection)
                try {
                    assertTrue(newConnection.view().connected, "a later login survives subsequent starts")
                    assertFalse(restarted.view().loginRequired)
                    assertEquals(1, disconnects)
                } finally { restarted.close() }
            }
        }
    }

    @Test fun `older verified successful receipts do not report failure or log out`() {
        for ((phase, code) in listOf("installed" to 0, "reboot-required" to 3010)) {
            DesktopSession(directory.resolve("old-$phase").toString(), 18182).use { session ->
                login(session)
                val path = receipt(session, phase, code, target = "0.0.0")
                val preserved = listOf(session.directory.resolve("server-session.enc"), path.resolve("request.json"),
                    path.resolve("result.json"), path.resolve("commit")).associateWith(Files::readAllBytes)
                val connection = DesktopConnection(session, mapper, ApplicationEventPublisher { fail("old success must not log out") })
                repeat(2) {
                    val updates = service(session, connection)
                    try {
                        assertTrue(connection.view().connected)
                        assertEquals("idle", updates.view().phase)
                        assertFalse(updates.view().loginRequired)
                        assertFalse(Files.exists(path.resolve("handled")), "historic receipts remain intact")
                        preserved.forEach { (file, bytes) -> assertArrayEquals(bytes, Files.readAllBytes(file)) }
                    } finally { updates.close() }
                }
            }
        }
    }

    @Test fun `cancelled failed mismatched uncommitted and missing results preserve login`() {
        data class Case(val phase: String, val code: Int, val target: String = ReleaseVersion.version,
                        val resultTarget: String = target, val committed: Boolean = true, val missing: Boolean = false)
        val cases = listOf(Case("cancelled", 1602), Case("failed", 1603), Case("installed", 1603),
            Case("reboot-required", 0), Case("installed", 0, target = "99.0.0"),
            Case("cancelled", 1602, target = "0.0.0"), Case("failed", 1603, target = "0.0.0"),
            Case("installed", 0, target = "0.0.0", resultTarget = "99.0.0"), Case("installed", 0, target = "0.0.0", committed = false),
            Case("installed", 0, resultTarget = "99.0.0"), Case("installed", 0, committed = false),
            Case("installing", -1), Case("installed", 0, missing = true))
        cases.forEachIndexed { index, value ->
            DesktopSession(directory.resolve("failure-$index").toString(), 18182).use { session ->
                login(session)
                val file = session.directory.resolve("server-session.enc")
                val original = Files.readAllBytes(file)
                val connection = DesktopConnection(session, mapper, ApplicationEventPublisher { fail("must not log out") })
                val path = receipt(session, value.phase, value.code, value.target, value.resultTarget, value.committed)
                if (value.missing) Files.delete(path.resolve("result.json"))
                val updates = service(session, connection)
                try {
                    assertTrue(connection.view().connected, "scenario $index")
                    assertArrayEquals(original, Files.readAllBytes(file), "scenario $index")
                    assertFalse(updates.view().loginRequired)
                    assertEquals("error", updates.view().phase)
                    assertFalse(Files.exists(path.resolve("handled")))
                } finally { updates.close() }
            }
        }
    }
}
