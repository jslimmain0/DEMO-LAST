package com.flowlink.server.security

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.tenant.TenantContext
import com.flowlink.mcp.McpCredentials
import com.flowlink.security.AppJwt
import com.flowlink.workspace.WorkspaceService
import com.nimbusds.jwt.JWTClaimsSet
import org.springframework.core.env.Environment
import org.springframework.http.HttpStatus
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtException
import org.springframework.web.server.ResponseStatusException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.time.Instant
import java.util.Date
import java.util.UUID

data class McpTokenRecord(val tokenId: String, val tokenHash: String, val username: String, val tenant: String,
                          val roles: List<String>, val sourceSession: String, val sourceExpiresAt: Long,
                          val expiresAt: Long, val deviceId: String, val clientId: String)
data class McpTokenResponse(val tokenId: String, val accessToken: String, val expiresAt: String,
                            val deviceId: String, val clientId: String)

/** Persist only token hashes and bindings, never GitHub, app or MCP bearer credentials. */
class McpTokenService(private val appJwt: AppJwt, private val workspace: WorkspaceService,
                      private val mapper: ObjectMapper, environment: Environment) : McpCredentials {
    // ponytail: one server JVM and at most 10,000 registrations; use a DB table before scaling hosts or write throughput.
    private val file = Path.of(environment.getProperty("flowlink.mcp.tokens-file",
        System.getProperty("user.home") + "/.flowlink/mcp-tokens.json"))
    private var records: MutableMap<String, McpTokenRecord> = if (Files.exists(file)) {
        check(Files.size(file) <= 8L * 1024 * 1024) { "MCP 연결 저장소 크기 제한을 초과했습니다" }
        mapper.readValue(file.toFile(), object : TypeReference<MutableMap<String, McpTokenRecord>>() {}).also {
            check(it.size <= 10_000) { "MCP 연결 저장소 등록 한도를 초과했습니다" }
        }
    } else linkedMapOf()
    private val mcpDecoder = appJwt.rawDecoder()
    private val appDecoder = appJwt.decoder()

    @Synchronized fun issue(appToken: String, deviceId: String, clientId: String): McpTokenResponse {
        require(deviceId.matches(Regex("[a-zA-Z0-9._:-]{1,128}"))) { "유효한 장치 ID가 필요합니다" }
        require(clientId in setOf("vscode", "intellij") || clientId.startsWith("oauth:") && clientId.length <= 128) { "지원하지 않는 MCP 클라이언트입니다" }
        val source = source(appToken)
        val session = hash(appToken)
        val previous = records.values.firstOrNull { it.sourceSession == session && it.deviceId == deviceId && it.clientId == clientId }
        return rotate(source, session, deviceId, clientId, previous?.tokenId ?: UUID.randomUUID().toString())
    }

    @Synchronized fun refresh(appToken: String, tokenId: String): McpTokenResponse {
        val source = source(appToken)
        val record = owned(appToken, tokenId)
        return rotate(source, record.sourceSession, record.deviceId, record.clientId, tokenId)
    }

    @Synchronized fun revoke(appToken: String, tokenId: String? = null) {
        source(appToken, requireApproved = false)
        if (tokenId != null) owned(appToken, tokenId)
        val session = hash(appToken)
        save(LinkedHashMap(records).apply { entries.removeIf { it.value.sourceSession == session && (tokenId == null || it.key == tokenId) } })
    }

    override fun issueForOAuth(appToken: String, clientId: String): String = issue(appToken, "oauth", "oauth:$clientId").accessToken

    @Synchronized override fun managementAuthorization(authorization: String?): String {
        val token = authorization?.takeIf { it.startsWith("Bearer ", true) }?.substring(7)
            ?: throw JwtException("MCP 로그인 토큰이 필요합니다")
        val jwt = mcpDecoder.decode(token)
        if (jwt.getClaimAsString("iss") != "flowlink" || jwt.audience != listOf("flowlink-mcp") ||
            jwt.getClaimAsString("purpose") != "mcp" || jwt.getClaimAsString("scope") != "flowlink:tools") {
            throw JwtException("MCP 전용 토큰이 필요합니다")
        }
        val record = records[jwt.id] ?: throw JwtException("해제된 MCP 연결입니다")
        if (!MessageDigest.isEqual(hash(token).toByteArray(), record.tokenHash.toByteArray()) ||
            record.username != jwt.subject || record.tenant != jwt.getClaimAsString(AppJwt.CLAIM_TENANT) ||
            record.expiresAt <= Instant.now().epochSecond || record.sourceExpiresAt <= Instant.now().epochSecond) {
            throw JwtException("MCP 연결 토큰이 만료되거나 변경됐습니다")
        }
        requireApproved(record.username, record.tenant)
        return "Bearer " + appJwt.issue(record.username, record.tenant, record.roles,
            minOf(Instant.now().plusSeconds(300), Instant.ofEpochSecond(record.sourceExpiresAt)),
            internalMcpDevice = record.deviceId.takeUnless { it == "oauth" })
    }

    private fun source(token: String, requireApproved: Boolean = true): Jwt {
        val source = appDecoder.decode(token)
        if (source.getClaimAsString("iss") != "flowlink" || source.subject.isNullOrBlank() || source.expiresAt == null ||
            !source.expiresAt!!.isAfter(Instant.now())) {
            throw JwtException("중앙 로그인 세션이 필요합니다")
        }
        if (requireApproved) requireApproved(source.subject, source.getClaimAsString(AppJwt.CLAIM_TENANT) ?: TenantContext.DEFAULT_TENANT)
        return source
    }

    private fun requireApproved(username: String, tenant: String) {
        val previous = TenantContext.getTenantId()
        try {
            TenantContext.setTenantId(tenant)
            if (!workspace.isApproved(username)) throw ResponseStatusException(HttpStatus.FORBIDDEN, "가입 승인이 필요하거나 계정이 차단됐습니다")
        } finally { TenantContext.setTenantId(previous) }
    }

    private fun owned(token: String, id: String): McpTokenRecord = records[id]?.takeIf { it.sourceSession == hash(token) }
        ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "MCP 연결을 찾을 수 없습니다")

    private fun rotate(source: Jwt, session: String, deviceId: String, clientId: String, id: String): McpTokenResponse {
        val now = Instant.now()
        val expires = minOf(now.plusSeconds(7L * 24 * 3600), source.expiresAt!!)
        val tenant = source.getClaimAsString(AppJwt.CLAIM_TENANT) ?: TenantContext.DEFAULT_TENANT
        val roles = (source.getClaim<Map<String, Any>>("realm_access")?.get("roles") as? List<*>)?.filterIsInstance<String>().orEmpty()
        val token = appJwt.sign(JWTClaimsSet.Builder().subject(source.subject).issuer("flowlink")
            .audience("flowlink-mcp").jwtID(id).issueTime(Date.from(now)).expirationTime(Date.from(expires))
            .claim("purpose", "mcp").claim("scope", "flowlink:tools").claim(AppJwt.CLAIM_TENANT, tenant)
            .claim("device_id", deviceId).claim("client_id", clientId).claim("generation", UUID.randomUUID().toString()).build())
        val next = LinkedHashMap(records).apply { entries.removeIf { it.value.expiresAt <= now.epochSecond } }
        if (id !in next && next.size >= 10_000) throw ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "MCP 연결 한도에 도달했습니다")
        if (id !in next && next.values.count { it.username == source.subject && it.tenant == tenant } >= 100) {
            throw ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "계정별 MCP 연결 한도에 도달했습니다")
        }
        next[id] = McpTokenRecord(id, hash(token), source.subject, tenant, roles, session, source.expiresAt!!.epochSecond,
            expires.epochSecond, deviceId, clientId)
        save(next)
        return McpTokenResponse(id, token, expires.toString(), deviceId, clientId)
    }

    private fun save(next: MutableMap<String, McpTokenRecord>) {
        Files.createDirectories(file.toAbsolutePath().parent)
        val temporary = Files.createTempFile(file.toAbsolutePath().parent, ".mcp-tokens-", ".tmp")
        try {
            mapper.writeValue(temporary.toFile(), next)
            if (Files.getFileStore(temporary).supportsFileAttributeView("posix")) {
                Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------"))
            }
            Files.move(temporary, file, ATOMIC_MOVE, REPLACE_EXISTING)
            records = next
        } finally { Files.deleteIfExists(temporary) }
    }

    companion object {
        fun hash(value: String): String = java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)))
    }
}
