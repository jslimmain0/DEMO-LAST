package com.flowlink.server.security

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.core.repository.AppSettingRepository
import com.flowlink.security.AppJwt
import com.flowlink.security.AuthProperties
import com.flowlink.settings.SettingsService
import com.flowlink.workspace.WorkspaceService
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.mockito.Mockito
import org.springframework.mock.env.MockEnvironment
import org.springframework.security.oauth2.jwt.JwtException
import org.springframework.security.oauth2.jwt.BadJwtException
import org.springframework.web.server.ResponseStatusException
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/** Credential checks only: no MCP protocol, tool calls, IDE registration or real login. */
class McpTokenServiceTest {
    @TempDir lateinit var directory: Path
    private val app = AppJwt(AuthProperties(jwtSecret = "unit-test-signing-key"), SettingsService(Mockito.mock(AppSettingRepository::class.java)))
    private val workspace = Mockito.mock(WorkspaceService::class.java).also { Mockito.`when`(it.isApproved("alice")).thenReturn(true) }
    private fun service() = McpTokenService(app, workspace, jacksonObjectMapper(),
        MockEnvironment().withProperty("flowlink.mcp.tokens-file", directory.resolve("tokens.json").toString()))

    @Test fun `MCP token survives restart without persisting credentials and cannot authorize management API`() {
        val source = app.issue("alice", roles = listOf("editor"))
        val first = service().issue(source, "pc-1", "vscode")
        // BadJwtException is invalid credentials (401); plain JwtException is an auth service failure (500).
        assertThrows(BadJwtException::class.java) { app.decoder().decode(first.accessToken) }
        assertThrows(JwtException::class.java) { service().managementAuthorization("Bearer $source") }
        val internal = service().managementAuthorization("Bearer ${first.accessToken}").removePrefix("Bearer ")
        val claims = app.decoder().decode(internal)
        assertThat(claims.subject).isEqualTo("alice")
        assertThat(claims.getClaimAsString("mcp_device")).isEqualTo("pc-1")
        assertThat(claims.getClaim<Map<String, Any>>("realm_access")["roles"]).isEqualTo(listOf("editor"))
        assertThat(claims.expiresAt).isBefore(Instant.now().plusSeconds(301))
        val stored = Files.readString(directory.resolve("tokens.json"))
        assertThat(stored).doesNotContain(source, first.accessToken, internal)
    }

    @Test fun `rotation invalidates old token and logout revokes only its source login session`() {
        val source = app.issue("alice")
        val otherSession = app.issue("alice")
        val service = service()
        val first = service.issue(source, "pc-1", "vscode")
        val other = service.issue(otherSession, "pc-2", "intellij")
        assertThrows(ResponseStatusException::class.java) { service.refresh(otherSession, first.tokenId) }
        val refreshed = service.refresh(source, first.tokenId)
        assertThat(refreshed.tokenId).isEqualTo(first.tokenId)
        assertThrows(JwtException::class.java) { service.managementAuthorization("Bearer ${first.accessToken}") }
        service.revoke(source)
        assertThrows(JwtException::class.java) { service.managementAuthorization("Bearer ${refreshed.accessToken}") }
        assertThat(service.managementAuthorization("Bearer ${other.accessToken}")).startsWith("Bearer ")
    }

    @Test fun `source expiry and current account approval bound every MCP credential`() {
        val sourceExpires = Instant.ofEpochSecond(Instant.now().epochSecond + 120)
        val source = app.issue("alice", expiresAt = sourceExpires)
        val service = service()
        val token = service.issue(source, "pc-1", "vscode")
        assertThat(Instant.parse(token.expiresAt)).isEqualTo(sourceExpires)
        Mockito.`when`(workspace.isApproved("alice")).thenReturn(false)
        assertThrows(ResponseStatusException::class.java) { service.managementAuthorization("Bearer ${token.accessToken}") }
        assertThrows(ResponseStatusException::class.java) { service.issue(source, "pc-1", "vscode") }
        service.revoke(source) // Blocked accounts can still disconnect their own IDE.
    }

    @Test fun `unauthenticated expired and unsupported clients cannot receive MCP token`() {
        val service = service()
        assertThrows(JwtException::class.java) { service.issue("not-a-jwt", "pc-1", "vscode") }
        assertThrows(JwtException::class.java) { service.issue(app.issue("alice", expiresAt = Instant.now().minusSeconds(120)), "pc-1", "vscode") }
        assertThrows(IllegalArgumentException::class.java) { service.issue(app.issue("alice"), "pc-1", "unknown") }
        assertThrows(IllegalArgumentException::class.java) { service.issue(app.issue("alice"), "../device", "vscode") }
    }

    @Test fun `optional IDE OAuth credentials use the currently connected PC rather than a Windows device binding`() {
        val service = service()
        val token = service.issueForOAuth(app.issue("alice"), "registered-test-client")
        val internal = service.managementAuthorization("Bearer $token").removePrefix("Bearer ")
        assertThat(app.decoder().decode(internal).getClaimAsString("mcp_device")).isNull()
    }
}
