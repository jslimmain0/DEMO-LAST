package com.flowlink.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.UUID

/** Immutable per invocation. Never retain a user's bearer in a singleton or environment. */
data class McpInvocation(val origin: String, val authorization: String?, val target: String = "server", val workspaceId: String? = null)

class McpApiException(val status: Int, message: String, val response: JsonNode? = null) : RuntimeException(message)

class McpRestClient(private val mapper: ObjectMapper) {
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build()

    fun api(ctx: McpInvocation, method: String, path: String, body: JsonNode? = null, query: Map<String, String?> = emptyMap(), viaPc: Boolean = ctx.target == "local", remoteOnPc: Boolean = false): JsonNode {
        require(path.startsWith('/') && !path.startsWith("//") && !path.contains('?') && !path.contains('#')) { "잘못된 API 경로" }
        val params = query.toMutableMap()
        if (ctx.workspaceId != null && params["workspaceId"] == null) params["workspaceId"] = ctx.workspaceId
        val payload = if (method == "POST" && path in setOf("/protocols", "/plugins/scripts", "/mock-servers", "/flows", "/folders") && ctx.workspaceId != null) {
            (body?.deepCopy<JsonNode>() as? ObjectNode ?: mapper.createObjectNode()).apply {
                if (!hasNonNull("workspaceId")) put("workspaceId", ctx.workspaceId)
            }
        } else body
        val apiPath = "/api/v1" + (if (remoteOnPc) "/remote" else "") + path
        return if (viaPc) bridge(ctx, method, apiPath, payload, params) else direct(ctx, method, apiPath, payload, params)
    }

    fun direct(ctx: McpInvocation, method: String, path: String, body: JsonNode? = null, query: Map<String, String?> = emptyMap()): JsonNode {
        require(path.startsWith("/api/v1/") && !path.contains('\\') && !path.contains("..")) { "관리 API 경로만 허용됩니다" }
        val suffix = query.filterValues { !it.isNullOrEmpty() }.entries.joinToString("&") { "${segment(it.key)}=${segment(it.value!!)}" }
        val uri = URI.create(ctx.origin + path + if (suffix.isEmpty()) "" else "?$suffix")
        val builder = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(150)).header("Accept", "application/json")
        ctx.authorization?.let { builder.header("Authorization", it) }
        if (body != null) builder.header("Content-Type", "application/json")
        builder.method(method, body?.let { HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(it)) } ?: HttpRequest.BodyPublishers.noBody())
        val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        require(response.body().length <= 8 * 1024 * 1024) { "API 응답이 8MB 제한을 초과했습니다" }
        val parsed = runCatching { mapper.readTree(response.body()) }.getOrNull() ?: mapper.nullNode()
        if (response.statusCode() !in 200..299) throw apiError(response.statusCode(), parsed)
        return parsed
    }

    private fun bridge(ctx: McpInvocation, method: String, path: String, body: JsonNode?, query: Map<String, String?>): JsonNode {
        val requestId = UUID.randomUUID().toString()
        val command = mapper.valueToTree<JsonNode>(mapOf("requestId" to requestId, "method" to method, "path" to path, "body" to body, "query" to query.filterValues { !it.isNullOrEmpty() }))
        // Once submitted, only inspect this command. A lost response never resubmits a mutation.
        var result = try { direct(ctx, "POST", "/api/v1/desktop-bridge/requests", command) }
        catch (ex: McpApiException) {
            if (ex.status in 400..499) throw ex
            throw IllegalStateException("PC 요청 $requestId 접수 결과를 확인하지 못했습니다. 자동 재시도하지 마세요: ${ex.message}", ex)
        }
        catch (ex: Exception) { throw IllegalStateException("PC 요청 $requestId 접수 결과를 확인하지 못했습니다. 자동 재시도하지 마세요: ${ex.message}", ex) }
        val deadline = System.nanoTime() + Duration.ofSeconds(150).toNanos()
        while (result.path("status").asText() in setOf("PENDING", "RUNNING") && System.nanoTime() < deadline) {
            Thread.sleep(300)
            result = try { direct(ctx, "GET", "/api/v1/desktop-bridge/requests/$requestId") }
            catch (ex: Exception) { throw IllegalStateException("PC 요청 $requestId 결과 조회에 실패했습니다. 재접수하지 말고 상태를 확인하세요: ${ex.message}", ex) }
        }
        val status = result.path("status").asText()
        val httpStatus = result.path("httpStatus").asInt(0)
        if (status == "SUCCEEDED" && httpStatus in 200..299) return result.get("body") ?: mapper.nullNode()
        if (httpStatus >= 400) throw apiError(httpStatus, result.get("body") ?: result)
        throw IllegalStateException("PC 요청 $requestId: ${result.path("message").asText(status)}. 결과가 불명확하면 다시 실행하지 마세요.")
    }

    private fun apiError(status: Int, body: JsonNode): McpApiException {
        val message = body.path("message").asText().ifBlank { body.path("error").asText().ifBlank { "HTTP $status" } }
        val position = listOfNotNull(body.get("line")?.let { "${it.asText()}행" }, body.get("col")?.let { "${it.asText()}열" }).joinToString(" ")
        return McpApiException(status, if (position.isBlank()) message else "$position: $message", body)
    }

    companion object {
        fun segment(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20")
    }
}
