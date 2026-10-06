package com.flowlink.common.bridge

import com.fasterxml.jackson.databind.JsonNode
import java.util.UUID

data class DesktopCommand(val requestId: UUID, val method: String, val path: String, val body: JsonNode? = null, val query: Map<String, String> = emptyMap())
data class DesktopCommandResult(val requestId: UUID, val status: String, val httpStatus: Int? = null, val body: JsonNode? = null, val message: String? = null)
data class DesktopBridgeRegistration(val deviceId: String)
data class DesktopBridgeSession(val sessionId: String, val credential: String)

/** This is a bounded resource operation channel, never an arbitrary local HTTP proxy. */
object DesktopCommandPolicy {
    const val MAX_BYTES = 1024 * 1024
    fun validate(command: DesktopCommand) {
        require(command.method in setOf("GET", "POST", "PUT", "PATCH", "DELETE")) { "허용되지 않은 개인 작업입니다." }
        require(command.path.length < 1000 && !Regex("(?i)%2f|%5c").containsMatchIn(command.path)) { "잘못된 개인 작업 경로입니다." }
        val decoded = java.net.URLDecoder.decode(command.path, Charsets.UTF_8)
        require(!decoded.contains('\\') && decoded.none { it.code < 32 } && decoded.split('/').none { it == "." || it == ".." }) { "잘못된 개인 작업 경로입니다." }
        val local = Regex("/api/v1/(flows|folders|environments|mock-servers|protocols|executions|plugins/scripts|transforms)(/[\\p{L}\\p{N}_ .:+-]+)*").matches(decoded)
        // Team mutations use the native proxy, which registers dispatcher execution IDs.
        val team = command.method == "POST" && (Regex("/api/v1/remote/flows/[0-9a-fA-F-]{36}/runs").matches(decoded) || Regex("/api/v1/remote/executions/[0-9a-fA-F-]{36}/rerun").matches(decoded))
        val metadata = command.method == "GET" && decoded in setOf("/api/v1/secrets", "/api/v1/workspaces", "/api/v1/codecs", "/api/v1/schemas")
        val workspaceTransfer = Regex("/api/v1/workspaces/[0-9a-fA-F-]{36}/(export|import)").matches(decoded) && command.method in setOf("GET", "POST")
        val http = command.method == "POST" && decoded == "/api/v1/agent/http-request"
        require(local || team || metadata || workspaceTransfer || http) { "개인 작업 채널에서 지원하지 않는 경로입니다." }
        require(command.query.size <= 12 && command.query.all { (key, value) -> key in setOf("workspaceId", "folderId", "flowId", "status", "range", "limit", "offset", "page", "size") && value.length <= 100 }) { "잘못된 개인 작업 조회 조건입니다." }
        require((command.body?.toString()?.toByteArray(Charsets.UTF_8)?.size ?: 0) <= MAX_BYTES) { "개인 작업 요청은 1MB 이하여야 합니다." }
    }
}
