package com.flowlink.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress

class McpGraphLayoutTest {
    private val mapper = jacksonObjectMapper()
    private fun graph(): JsonNode = mapper.readTree("""{"name":"branch", "palette":[{"name":"keep"}], "nodes":[
        {"id":"start","type":"start","x":900,"y":1},
        {"id":"if","type":"if","cond":"true","x":900,"y":1},
        {"id":"a","type":"http","executionAgent":"local","rawBody":"{{ value@if }}","x":900,"y":1},
        {"id":"b","type":"tcp","protocolId":"keep","x":900,"y":1},
        {"id":"merge","type":"set","x":900,"y":1},
        {"id":"end","type":"end","x":1900,"y":1},
        {"id":"note","type":"note","x":55,"y":66,"noteText":"keep"}],
        "edges":[{"id":"1","from":"start","to":"if"},{"id":"2","from":"if","fromPort":"true","to":"a"},
        {"id":"3","from":"if","fromPort":"false","to":"b"},{"id":"4","from":"a","to":"merge"},
        {"id":"5","from":"b","to":"merge"},{"id":"6","from":"merge","to":"end"}]}""")

    @Test fun `new workflow becomes a compact tree with aligned entry and exit and unchanged execution data`() {
        val source = graph(); val original = source.deepCopy<JsonNode>()
        val result = McpGraphLayout.forSave(source, true, null)
        val nodes = result.path("nodes").associateBy { it.path("id").asText() }
        assertEquals(nodes.getValue("start").path("x"), nodes.getValue("end").path("x"))
        assertEquals(nodes.getValue("a").path("y"), nodes.getValue("b").path("y"))
        assertTrue(nodes.getValue("a").path("x").asInt() < nodes.getValue("b").path("x").asInt())
        assertTrue(nodes.getValue("merge").path("y").asInt() > nodes.getValue("a").path("y").asInt())
        assertTrue(nodes.getValue("end").path("y").asInt() > nodes.getValue("merge").path("y").asInt())
        assertEquals(result.path("nodes").filter { it.path("type").asText() != "note" }.size,
            result.path("nodes").filter { it.path("type").asText() != "note" }.map { it.path("x").asInt() to it.path("y").asInt() }.distinct().size)
        assertEquals(source.path("edges"), result.path("edges"))
        assertEquals(source.path("palette"), result.path("palette"))
        source.path("nodes").forEach { before ->
            val after = nodes.getValue(before.path("id").asText()).deepCopy<ObjectNode>()
            after.set<JsonNode>("x", before.path("x")); after.set<JsonNode>("y", before.path("y"))
            assertEquals(before, after)
        }
        assertEquals(original, source)
        assertEquals(result, McpGraphLayout.forSave(result, true, null))
    }

    @Test fun `existing edits and explicit preserve retain authored coordinates`() {
        val source = graph()
        assertSame(source, McpGraphLayout.forSave(source, false, null))
        assertSame(source, McpGraphLayout.forSave(source, true, "preserve"))
        assertNotEquals(source, McpGraphLayout.forSave(source, false, "compact-tree"))
        assertThrows(IllegalArgumentException::class.java) { McpGraphLayout.forSave(source, true, "other") }
    }

    @Test fun `linear workflows use one column and multiple ends remain aligned without overlap`() {
        val source = mapper.readTree("""{"nodes":[{"id":"s","type":"start"},{"id":"a","type":"set"},{"id":"e1","type":"end"},{"id":"e2","type":"end"}],"edges":[{"from":"s","to":"a"},{"from":"a","to":"e1"},{"from":"a","to":"e2"}]}""")
        val result = McpGraphLayout.forSave(source, true, null)
        assertEquals(1, result.path("nodes").map { it.path("x").asInt() }.distinct().size)
        assertEquals(4, result.path("nodes").map { it.path("y").asInt() }.distinct().size)
    }

    @Test fun `cycles and duplicate ids are preserved for REST validation`() {
        val cycle = mapper.readTree("""{"nodes":[{"id":"a","type":"set"},{"id":"b","type":"set"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"a"}]}""")
        assertSame(cycle, McpGraphLayout.forSave(cycle, true, null))
        val duplicate = mapper.readTree("""{"nodes":[{"id":"a","type":"start"},{"id":"a","type":"end"}],"edges":[]}""")
        assertSame(duplicate, McpGraphLayout.forSave(duplicate, true, null))
    }

    @Test fun `MCP save forwards arranged coordinates to REST for creates and preserves edits`() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val saved = mutableListOf<JsonNode>()
        server.createContext("/api/v1/flows") { exchange ->
            val body = mapper.readTree(exchange.requestBody)
            val reply = if (exchange.requestURI.path.endsWith("/versions")) {
                synchronized(saved) { saved.add(body.path("graph")) }
                "{\"versionNo\":1}"
            } else "{\"id\":\"test-flow\"}"
            val bytes = reply.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val tools = McpTools(mapper, McpRestClient(mapper))
            val invoke = McpTools::class.java.getDeclaredMethod("invoke", String::class.java, ObjectNode::class.java, McpInvocation::class.java).apply { isAccessible = true }
            val scope = McpInvocation("http://127.0.0.1:${server.address.port}", null, workspaceId = "public")
            val create = mapper.createObjectNode().put("name", "test").set<ObjectNode>("graph", graph())
            invoke.invoke(tools, "flow_upsert", create, scope)
            assertEquals(McpGraphLayout.forSave(graph(), true, null), saved[0])
            val edit = mapper.createObjectNode().put("id", "test-flow").set<ObjectNode>("graph", graph())
            invoke.invoke(tools, "flow_upsert", edit, scope)
            assertEquals(graph(), saved[1])
            edit.put("layout", "compact-tree")
            invoke.invoke(tools, "flow_upsert", edit, scope)
            assertEquals(saved[0], saved[2])
        } finally { server.stop(0) }
    }
}
