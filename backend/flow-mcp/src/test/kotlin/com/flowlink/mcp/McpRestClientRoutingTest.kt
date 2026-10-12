package com.flowlink.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets

/** Local fake management server, not an MCP transport or a real account. */
class McpRestClientRoutingTest {
    @Test fun `shared catalogs and writes remain public without opening a PC bridge and environment source remains separate`() {
        val mapper = jacksonObjectMapper()
        data class Request(val path: String, val query: String?, val body: JsonNode?, val authorization: String?)
        val requests = mutableListOf<Request>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/v1") { exchange ->
            val bytes = exchange.requestBody.readAllBytes()
            requests += Request(exchange.requestURI.path, exchange.requestURI.rawQuery,
                if (bytes.isEmpty()) null else mapper.readTree(bytes), exchange.requestHeaders.getFirst("Authorization"))
            val response = "{}".toByteArray(StandardCharsets.UTF_8)
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, response.size.toLong())
            exchange.responseBody.use { it.write(response) }
        }
        server.start()
        try {
            val context = McpInvocation("http://127.0.0.1:${server.address.port}", "Bearer synthetic-only", "local", "private-old")
            val client = McpRestClient(mapper)
            for (path in listOf("/protocols", "/secrets", "/plugins/scripts", "/transforms", "/codecs"))
                client.api(context, "GET", path, query = mapOf("workspaceId" to "old-team"))
            val raw = mapper.readTree("""{"name":"new","workspaceId":"private-old","spec":{}}""")
            client.api(context, "POST", "/protocols", raw)
            client.api(context.copy(target = "server", workspaceId = "team"), "GET", "/environments")
            assertEquals(7, requests.size)
            assertTrue(requests.all { !it.path.contains("desktop-bridge") && !it.path.contains("/remote/") })
            assertTrue(requests.all { it.query == "workspaceId=public" })
            assertTrue(requests.all { it.authorization == "Bearer synthetic-only" })
            assertEquals("public", requests[5].body!!.path("workspaceId").asText())
            assertEquals("private-old", raw.path("workspaceId").asText(), "routing must not mutate a caller's definition")
            assertTrue(requests.all { it.body?.has("resourceIdentity") != true })
        } finally { server.stop(0) }
    }

    @Test fun `local mutations retain their original workspace query and body ownership`() {
        val mapper = jacksonObjectMapper()
        val requests = mutableListOf<JsonNode>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/v1/desktop-bridge/requests") { exchange ->
            val command = mapper.readTree(exchange.requestBody)
            requests.add(command)
            val response = mapper.writeValueAsBytes(mapOf("status" to "SUCCEEDED", "httpStatus" to 201, "body" to mapOf("id" to "new-flow")))
            exchange.sendResponseHeaders(200, response.size.toLong()); exchange.responseBody.use { it.write(response) }
        }
        server.start()
        try {
            val client = McpRestClient(mapper)
            val ctx = McpInvocation("http://127.0.0.1:${server.address.port}", "Bearer synthetic-only", "local", "pc")
            client.api(ctx, "POST", "/flows", mapper.readTree("""{"name":"new"}"""))
            assertEquals(1, requests.size)
            assertEquals("/api/v1/flows", requests[0].path("path").asText())
            assertEquals("pc", requests[0].path("body").path("workspaceId").asText())
            assertEquals("pc", requests[0].path("query").path("workspaceId").asText())
            assertFalse(requests[0].path("body").has("resourceIdentity"))
            assertFalse(requests[0].path("body").has("agentDeviceId"))
        } finally { server.stop(0) }
    }
}
