package com.flowlink.mcp

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.core.env.Environment
import org.springframework.security.oauth2.core.AuthorizationGrantType
import org.springframework.security.oauth2.core.ClientAuthenticationMethod
import org.springframework.security.oauth2.server.authorization.client.RegisteredClient
import org.springframework.security.oauth2.server.authorization.client.RegisteredClientRepository
import org.springframework.security.oauth2.server.authorization.settings.ClientSettings
import org.springframework.security.oauth2.server.authorization.settings.TokenSettings
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.attribute.PosixFilePermissions
import java.time.Duration
import java.time.Instant

internal data class McpClientRecord(val id: String, val name: String, val redirects: List<String>, val authMethod: String,
                                  val secretHash: String?, val issued: Long)

/** Only public client metadata and hashed client secrets are persisted, never user JWTs. */
class McpClientRepository(private val mapper: ObjectMapper, env: Environment) : RegisteredClientRepository {
    private val file = Path.of(env.getProperty("flowlink.mcp.clients-file", System.getProperty("user.home") + "/.flowlink/mcp-clients-kotlin.json"))
    private val clients: MutableMap<String, McpClientRecord> = if (Files.exists(file)) {
        mapper.readValue(file.toFile(), object : TypeReference<MutableMap<String, McpClientRecord>>() {})
    } else linkedMapOf()

    @Synchronized override fun save(client: RegisteredClient) {
        check(clients.containsKey(client.id) || clients.size < 10_000) { "MCP 클라이언트 등록 한도에 도달했습니다." }
        val method = client.clientAuthenticationMethods.single().value
        val record = McpClientRecord(client.id, client.clientName, client.redirectUris.toList(), method, client.clientSecret,
            client.clientIdIssuedAt?.epochSecond ?: Instant.now().epochSecond)
        val next = LinkedHashMap(clients).apply { put(client.id, record) }
        Files.createDirectories(file.toAbsolutePath().parent)
        val tmp = Files.createTempFile(file.toAbsolutePath().parent, ".mcp-clients-", ".tmp")
        try {
            mapper.writeValue(tmp.toFile(), next)
            if (Files.getFileStore(tmp).supportsFileAttributeView("posix")) Files.setPosixFilePermissions(tmp, PosixFilePermissions.fromString("rw-------"))
            Files.move(tmp, file, ATOMIC_MOVE, REPLACE_EXISTING)
            clients[client.id] = record
        } finally { Files.deleteIfExists(tmp) }
    }

    @Synchronized override fun findById(id: String): RegisteredClient? = clients[id]?.let(::registered)
    override fun findByClientId(clientId: String): RegisteredClient? = findById(clientId)

    private fun registered(c: McpClientRecord): RegisteredClient = RegisteredClient.withId(c.id).clientId(c.id)
        .clientName(c.name).clientIdIssuedAt(Instant.ofEpochSecond(c.issued)).clientSecret(c.secretHash)
        .clientAuthenticationMethod(ClientAuthenticationMethod(c.authMethod)).authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
        .redirectUris { it.addAll(c.redirects) }.scope("flowlink")
        .clientSettings(ClientSettings.builder().requireProofKey(true).requireAuthorizationConsent(true).build())
        .tokenSettings(TokenSettings.builder().authorizationCodeTimeToLive(Duration.ofMinutes(5)).build()).build()
}
