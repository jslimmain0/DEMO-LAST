package com.flowlink.server.bridge
import com.flowlink.common.bridge.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.springframework.web.server.ResponseStatusException
import java.util.UUID
class DesktopBridgeServiceTest {
    @Test fun `MCP device credentials cannot silently reach another PC of the same account`() {
        val service = DesktopBridgeService()
        val command = DesktopCommand(UUID.randomUUID(), "GET", "/api/v1/workspaces")
        service.connect("u", "pc-B")
        assertEquals(409, assertThrows(ResponseStatusException::class.java) { service.submit("u", command, "pc-A") }.statusCode.value())
        assertEquals("PENDING", service.submit("u", command, "pc-B").status)
        assertEquals(409, assertThrows(ResponseStatusException::class.java) { service.result("u", command.requestId, "pc-A") }.statusCode.value())
        assertEquals("PENDING", service.result("u", command.requestId, "pc-B").status)
        assertEquals("PENDING", service.result("u", command.requestId).status) // Ordinary app API remains compatible.
    }
    @Test fun `offline and identity and delivery fencing`() {
        val service = DesktopBridgeService()
        val command = DesktopCommand(UUID.randomUUID(), "GET", "/api/v1/flows")
        assertEquals(409, assertThrows(ResponseStatusException::class.java) { service.submit("u", command) }.statusCode.value())
        val session = service.connect("u", "pc")
        assertEquals("PENDING", service.submit("u", command).status)
        assertEquals("PENDING", service.submit("u", command).status)
        assertEquals(404, assertThrows(ResponseStatusException::class.java) { service.result("other", command.requestId) }.statusCode.value())
        assertEquals(403, assertThrows(ResponseStatusException::class.java) { service.poll("u", session.sessionId, "wrong") }.statusCode.value())
        assertEquals(listOf(command), service.poll("u", session.sessionId, session.credential))
        assertTrue(service.poll("u", session.sessionId, session.credential).isEmpty())
        service.complete("u", session.sessionId, session.credential, DesktopCommandResult(command.requestId, "SUCCEEDED", 200))
        assertEquals("SUCCEEDED", service.result("u", command.requestId).status)
        assertThrows(ResponseStatusException::class.java) { service.submit("u", command.copy(method="DELETE")) }
    }
    @Test fun `reconnect never reissues claimed mutation`() {
        val service = DesktopBridgeService()
        val session = service.connect("u", "pc")
        val command = DesktopCommand(UUID.randomUUID(), "POST", "/api/v1/flows")
        service.submit("u", command); service.poll("u", session.sessionId, session.credential)
        val next = service.connect("u", "pc")
        assertEquals("UNKNOWN", service.submit("u", command).status)
        assertTrue(service.poll("u", next.sessionId, next.credential).isEmpty())
        assertThrows(ResponseStatusException::class.java) { service.complete("u", session.sessionId, session.credential, DesktopCommandResult(command.requestId, "SUCCEEDED")) }
    }
    @Test fun `channel is bounded allowlist not local proxy`() {
        for (path in listOf("/api/v1/desktop/shutdown", "/api/v1/secrets/value", "/api/v1/admin", "/api/v1/flows/%2e", "https://other/api/v1/flows")) assertThrows(IllegalArgumentException::class.java) { DesktopCommandPolicy.validate(DesktopCommand(UUID.randomUUID(), "GET", path)) }
        DesktopCommandPolicy.validate(DesktopCommand(UUID.randomUUID(), "GET", "/api/v1/secrets"))
        DesktopCommandPolicy.validate(DesktopCommand(UUID.randomUUID(), "PUT", "/api/v1/environments/%EA%B0%9C%EB%B0%9C%20QA"))
        DesktopCommandPolicy.validate(DesktopCommand(UUID.randomUUID(), "GET", "/api/v1/workspaces"))
        DesktopCommandPolicy.validate(DesktopCommand(UUID.randomUUID(), "GET", "/api/v1/plugins/scripts"))
        assertThrows(IllegalArgumentException::class.java) { DesktopCommandPolicy.validate(DesktopCommand(UUID.randomUUID(), "GET", "/api/v1/flows/%2Fadmin")) }
        DesktopCommandPolicy.validate(DesktopCommand(UUID.randomUUID(), "POST", "/api/v1/agent/http-request"))
        DesktopCommandPolicy.validate(DesktopCommand(UUID.randomUUID(), "POST", "/api/v1/remote/flows/${UUID.randomUUID()}/runs"))
    }
}
