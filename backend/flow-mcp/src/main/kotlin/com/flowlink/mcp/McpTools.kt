package com.flowlink.mcp

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import io.modelcontextprotocol.common.McpTransportContext
import io.modelcontextprotocol.json.jackson.JacksonMcpJsonMapper
import io.modelcontextprotocol.json.schema.JsonSchemaValidator
import io.modelcontextprotocol.server.McpStatelessServerFeatures
import io.modelcontextprotocol.spec.McpSchema
import java.time.Duration

/** The REST API remains responsible for authorization, validation and storage. */
class McpTools(private val mapper: ObjectMapper, private val rest: McpRestClient) {
    private val jsonMapper = JacksonMcpJsonMapper(mapper)
    private val validator = JsonSchemaValidator.getDefault()
    private val catalog: List<JsonNode> = javaClass.getResourceAsStream("/flowlink-tools.json")!!.use { mapper.readTree(it).toList() }

    fun specifications(): List<McpStatelessServerFeatures.SyncToolSpecification> = catalog.map { definition ->
        val name = definition.path("name").asText()
        val schema = mapper.convertValue(definition.path("inputSchema"), object : TypeReference<Map<String, Any>>() {})
        val builder = McpSchema.Tool.builder().name(name).title(definition.path("title").asText())
            .description(definition.path("description").asText()).inputSchema(jsonMapper, mapper.writeValueAsString(schema))
        definition.get("annotations")?.let { builder.annotations(mapper.treeToValue(it, McpSchema.ToolAnnotations::class.java)) }
        McpStatelessServerFeatures.SyncToolSpecification(builder.build()) { context, request ->
            try {
                val arguments = request.arguments() ?: emptyMap()
                val validation = validator.validate(schema, arguments)
                require(validation.valid()) { "입력 형식이 올바르지 않습니다: ${validation.errorMessage()}" }
                val args = mapper.valueToTree<ObjectNode>(arguments)
                for (key in listOf("graph", "spec", "bundle", "codec")) if (args.path(key).isTextual) {
                    val value = try { mapper.readTree(args.path(key).asText()) } catch (ex: Exception) { throw IllegalArgumentException("$key JSON 파싱 실패: ${ex.message}") }
                    require(value.isObject) { "$key 는 JSON 객체여야 합니다" }
                    args.set<JsonNode>(key, value)
                }
                val initial = context.get("invocation") as McpInvocation
                var scoped = initial.copy(target = args.path("target").asText("server"))
                val unscoped = name in setOf("flowlink_status", "flowlink_update_status", "flowlink_guide", "workspace_list", "http_request")
                if (!unscoped || args.hasNonNull("workspace")) scoped = scoped.copy(workspaceId = workspace(scoped, args.text("workspace")).path("id").asText())
                McpSchema.CallToolResult(render(invoke(name, args, scoped)), false)
            } catch (ex: Exception) {
                val hint = when ((ex as? McpApiException)?.status) {
                    401 -> "\n→ Windows FlowLink 앱에서 로그인 상태를 확인하고 MCP 연결 설정을 갱신하세요. IDE에서 다시 로그인할 필요는 없습니다."
                    403 -> "\n→ 이 작업의 권한이나 관리자 승인을 확인하세요. flowlink_status로 상태를 확인할 수 있습니다."
                    else -> ""
                }
                McpSchema.CallToolResult("⚠ ${(ex as? McpApiException)?.let { "HTTP ${it.status}: " } ?: ""}${ex.message ?: "요청 처리 실패"}$hint", true)
            }
        }
    }

    private fun invoke(name: String, a: ObjectNode, c: McpInvocation): Any? {
        fun api(method: String, path: String, body: Any? = null, query: Map<String, String?> = emptyMap()): JsonNode = rest.api(c, method, path, body?.let { mapper.valueToTree(it) }, query)
        fun get(path: String) = api("GET", path)
        fun id() = enc(a.path("id").asText())
        fun mock() = named(get("/mock-servers"), a.path("slug").asText(), listOf("slug"), "Mock")
        fun mockPath() = "/mock-servers/${mock().path("id").asText()}"
        fun protocol(): JsonNode = named(get("/protocols"), a.text("id") ?: a.text("name") ?: "", listOf("id", "name"), "프로토콜")
        fun script(): JsonNode {
            val ref = a.path("id").asText()
            val hit = named(get("/plugins/scripts"), ref, listOf("id", "pluginId", "name"), "플러그인")
            return get("/plugins/scripts/${hit.path("id").asText()}")
        }
        fun fields(vararg names: String): ObjectNode = mapper.createObjectNode().apply { names.forEach { key -> a.get(key)?.let { set<JsonNode>(key, it) } } }
        fun version(base: String): JsonNode {
            val path = "$base/versions/${a.path("versionNo").asInt()}"
            return when { a.hasNonNull("pinned") -> api("PUT", "$path/pin", fields("pinned")); a.path("restore").asBoolean() -> api("POST", "$path/restore"); else -> get(path) }
        }
        when (name) {
            "flowlink_status" -> {
                val cfg = rest.api(c.copy(target = "server", workspaceId = null), "GET", "/auth/config")
                val mode = cfg.path("mode").asText(if (cfg.path("enabled").asBoolean()) "github" else "none")
                val me = if (mode == "github" && c.authorization != null) rest.api(c.copy(target = "server", workspaceId = null), "GET", "/admin/me") else null
                return mapOf("transport" to "http /mcp (중앙 서버)", "target" to c.target, "auth" to cfg, "account" to me,
                    "안내" to "target은 저장 공간이고 executionAgent는 요청 출발지입니다. 개인 자료는 온라인 Windows 앱에서 해당 요청만 전달합니다. HTTP/TCP는 선택한 에이전트가 실행합니다.")
            }
            "flowlink_update_status" -> return mapOf("release" to rest.api(c.copy(target = "server", workspaceId = null), "GET", "/distribution"), "안내" to "PC 설치 버전은 이 서버 연결에서 확인되지 않습니다. Windows 앱의 업데이트 창에서 확인·설치하세요.")
            "flowlink_guide" -> {
                val schemas = rest.api(c.copy(target = "server", workspaceId = null), "GET", "/schemas")
                val topic = a.path("topic").asText()
                val selected = if (topic == "all") schemas else schemas.path(if (topic == "nodes") "flow" else topic)
                return render(selected) + "\n\nMCP는 중앙 서버에만 있습니다. target local=PC 개인 H2, server=공용·팀 저장 공간. 노드 executionAgent는 별도 선택입니다. 개인 작업 및 PC 실행은 로그인한 Windows 앱이 온라인이어야 합니다. pendingAgent UNKNOWN은 재실행하지 말고 결과를 확인하세요. FORM은 실제 사용자 화면 작업이 필요하며 MCP는 팝업 성공을 가장하지 않습니다."
            }
            "workspace_list" -> return get("/workspaces")
            "workspace_get" -> return mapOf("workspace" to workspace(c, c.workspaceId), "folders" to folders(c), "flows" to get("/flows"), "mocks" to get("/mock-servers"))
            "workspace_export" -> return get("/workspaces/${enc(c.workspaceId!!)}/export")
            "workspace_import" -> return api("POST", "/workspaces/${enc(c.workspaceId!!)}/import", a.path("bundle"))
            "folder_list" -> return folders(c)
            "folder_create" -> return api("POST", "/folders", mapOf("name" to a.path("name").asText(), "parentId" to folder(c, a.text("parent"))?.path("id")?.asText(), "workspaceId" to c.workspaceId))
            "folder_update" -> {
                val f = folder(c, a.path("folder").asText()) ?: error("루트 폴더는 변경할 수 없습니다")
                val path = "/folders/${f.path("id").asText()}"
                if (a.hasNonNull("name")) api("PATCH", path, fields("name"))
                if (a.hasNonNull("parent")) api("PUT", "$path/parent", mapOf("parentId" to folder(c, a.text("parent"))?.path("id")?.asText()))
                return folders(c)
            }
            "folder_delete" -> { val f = folder(c, a.path("folder").asText()) ?: error("루트 폴더는 삭제할 수 없습니다"); api("DELETE", "/folders/${f.path("id").asText()}"); return "삭제됨" }
            "protocol_list" -> return get("/protocols")
            "protocol_get" -> return get("/protocols/${protocol().path("id").asText()}")
            "protocol_upsert" -> {
                val matches = get("/protocols").filter { it.path("name").asText() == a.path("name").asText() }
                require(matches.size <= 1) { "프로토콜 이름이 겹칩니다" }
                return if (matches.isEmpty()) api("POST", "/protocols", fields("name", "spec")) else api("PUT", "/protocols/${matches.first().path("id").asText()}", fields("spec"))
            }
            "protocol_preview" -> {
                val spec = if (a.hasNonNull("spec")) a.path("spec") else {
                    val p = named(get("/protocols"), a.text("protocolId") ?: a.text("name") ?: "", listOf("id", "name"), "프로토콜")
                    get("/protocols/${p.path("id").asText()}").path("spec")
                }
                return api("POST", "/protocols/preview", fields("key", "values", "environment").apply { set<JsonNode>("spec", spec); if (!has("values")) set<JsonNode>("values", mapper.createObjectNode()) })
            }
            "protocol_delete" -> { api("DELETE", "/protocols/${id()}"); return "삭제됨" }
            "mock_list" -> return get("/mock-servers/fleet").path("servers").filter { it.path("workspaceId").asText("public") == c.workspaceId }
            "mock_get" -> return get(mockPath())
            "mock_upsert" -> {
                val matches = get("/mock-servers").filter { it.path("slug").asText() == a.path("slug").asText() }
                require(matches.size <= 1) { "Mock slug가 겹칩니다. workspace를 지정하세요" }
                val m = matches.singleOrNull() ?: api("POST", "/mock-servers", fields("name", "slug", "type").apply { if (!has("name")) put("name", a.path("slug").asText()) })
                val path = "/mock-servers/${m.path("id").asText()}"
                api("PUT", "$path/spec", fields("spec").apply { put("note", "mcp") })
                if (a.hasNonNull("name") || a.hasNonNull("enabled")) api("PATCH", path, fields("name", "enabled"))
                return get(path)
            }
            "mock_send" -> return api("POST", "${mockPath()}/tcp-send", fields("key", "values"))
            "mock_log" -> {
                val m = mock(); val tcp = m.path("kind").asText() == "TCP"
                val logs = get("/mock-servers/${m.path("id").asText()}/${if (tcp) "tcp-log" else "requests"}")
                val rows = if (logs.isArray) logs else logs.path("items")
                return rows.toList().take(a.path("limit").asInt(20)).map { row -> row.deepCopy<JsonNode>().also { if (tcp && !a.path("hex").asBoolean() && it is ObjectNode) it.remove("hex") } }
            }
            "mock_delete" -> { api("DELETE", mockPath()); return "삭제됨: ${a.path("slug").asText()}" }
            "mock_versions" -> return get("${mockPath()}/versions")
            "mock_version" -> return version(mockPath())
            "mock_state" -> return get("${mockPath()}/state")
            "mock_reset" -> { api("POST", "${mockPath()}/reset"); return "초기화됨" }
            "mock_clear_log" -> { val m = mock(); api("DELETE", "/mock-servers/${m.path("id").asText()}/${if (m.path("kind").asText() == "TCP") "tcp-log" else "requests"}"); return "로그 비움" }
            "mock_usages" -> return mapOf("usages" to get("/mock-servers/usages"), "mocks" to get("/mock-servers"))
            "codec_try" -> return api("POST", "${mockPath()}/codec-try", fields("codec", "side", "message", "headers", "contentType", "environment"))
            "flow_list" -> {
                val list = get("/flows")
                val fs = folders(c).associate { it.path("id").asText() to it.path("path").asText() }
                val selectedFolder = if (a.hasNonNull("folder")) folder(c, a.text("folder"))?.path("id")?.asText() else null
                return list.filter { !a.hasNonNull("folder") || it.text("folderId") == selectedFolder }.map { row -> (row.deepCopy<JsonNode>() as ObjectNode).apply { put("folderPath", fs[row.path("folderId").asText()] ?: "/") } }
            }
            "flow_get" -> return get("/flows/${id()}")
            "flow_upsert" -> {
                var flowId = a.text("id")
                if (flowId == null) {
                    require(!a.text("name").isNullOrBlank()) { "name 또는 id가 필요합니다" }
                    flowId = api("POST", "/flows", mapOf("name" to a.text("name"), "folderId" to folder(c, a.text("folder"))?.text("id"), "workspaceId" to c.workspaceId)).path("id").asText()
                }
                val saved = api("POST", "/flows/${enc(requireNotNull(flowId))}/versions", mapOf("graph" to a.path("graph"), "note" to (a.text("note") ?: "mcp"), "pinned" to false))
                return mapOf("flowId" to flowId, "version" to saved, "target" to c.target, "workspace" to c.workspaceId)
            }
            "flow_update" -> {
                val path = "/flows/${id()}"
                val detail = get(path)
                if (a.hasNonNull("name") || a.hasNonNull("description")) api("PATCH", path, fields("name", "description"))
                if (a.hasNonNull("folder")) api("PUT", "$path/folder", mapOf("folderId" to folder(c.copy(workspaceId = detail.path("workspaceId").asText("public")), a.text("folder"))?.text("id")))
                return get(path)
            }
            "flow_delete" -> { api("DELETE", "/flows/${id()}"); return "삭제됨" }
            "flow_versions" -> return get("/flows/${id()}/versions")
            "flow_version" -> return version("/flows/${id()}")
            "flow_run", "node_run" -> {
                val flowId = if (name == "node_run") a.path("flowId").asText() else a.path("id").asText()
                val body = fields("input", "envName", "upstream")
                if (name == "node_run") body.put("onlyNodeId", a.path("nodeId").asText())
                val started = startRun(c, flowId, body)
                return waitDone(c, started, a.path("timeoutSec").asInt(120))
            }
            "execution_get" -> return executionOutput(get("/executions/${id()}"), a.path("full").asBoolean())
            "execution_list" -> return api("GET", "/executions", query = mapOf("flowId" to a.text("flowId"), "status" to a.text("status"), "limit" to a.path("limit").asInt(20).toString()))
            "execution_resume" -> {
                val ex = get("/executions/${id()}")
                val pending = listOf("pendingAgent", "pendingInput", "pendingForm", "pendingClient", "pendingWait").firstNotNullOfOrNull { ex.get(it)?.takeUnless(JsonNode::isNull) }
                    ?: return executionOutput(ex, false)
                val body = mapper.createObjectNode().put("nodeId", pending.path("nodeId").asText())
                when {
                    a.path("abort").asBoolean() -> { body.put("aborted", true); body.put("error", "MCP에서 중단") }
                    ex.hasNonNull("pendingAgent") || ex.hasNonNull("pendingWait") -> return executionOutput(ex, false)
                    ex.hasNonNull("pendingInput") -> body.set<JsonNode>("formValues", a.get("values") ?: mapper.createObjectNode())
                    ex.hasNonNull("pendingForm") -> return mapOf("execution" to executionOutput(ex, false), "안내" to "폼은 Windows 앱 화면에서 실제로 제출하세요. 팝업을 열지 않은 채 성공으로 재개하지 않습니다.")
                    else -> {
                        val response = httpRequest(c, pending.deepCopy<ObjectNode>().apply { put("executionAgent", "local") })
                        listOf("status", "body", "error").forEach { key -> response.get(key)?.let { body.set<JsonNode>(key, it) } }
                    }
                }
                return waitDone(c, api("POST", "/executions/${id()}/resume", body), a.path("timeoutSec").asInt(120))
            }
            "execution_rerun" -> {
                val ex = get("/executions/${id()}")
                val localNeeded = c.target == "server" && needsPc(c, ex.path("flowId").asText(), ex.text("flowVersionId"))
                val started = rest.api(c, "POST", "/executions/${id()}/rerun", viaPc = c.target == "local" || localNeeded, remoteOnPc = localNeeded)
                return waitDone(c, started, a.path("timeoutSec").asInt(120))
            }
            "suite_run" -> {
                var flowIds = a.path("flowIds").map(JsonNode::asText)
                if (flowIds.isEmpty()) {
                    val selectedFolder = folder(c, a.text("folder")) ?: error("folder 또는 flowIds가 필요합니다")
                    flowIds = get("/flows").filter { it.path("folderId").asText() == selectedFolder.path("id").asText() }.map { it.path("id").asText() }
                }
                require(flowIds.isNotEmpty()) { "실행할 워크플로가 없습니다" }
                val deadline = System.nanoTime() + Duration.ofSeconds(a.path("timeoutSec").asLong(180)).toNanos()
                // Each flow is submitted once; mixed PC/server flows use the same device journal as the UI.
                val started = flowIds.map { flowId -> flowId to runCatching { startRun(c, flowId, mapper.createObjectNode()) } }
                return started.map { (flowId, result) -> result.fold({ waitDone(c, it, ((deadline - System.nanoTime()) / 1_000_000_000).toInt().coerceAtLeast(0)) }, { mapOf("flowId" to flowId, "error" to it.message, "안내" to "접수 결과가 불명확하면 재실행하지 마세요") }) }
            }
            "env_list" -> return get("/environments")
            "env_put" -> return api("PUT", "/environments/${enc(a.path("name").asText())}", fields("vars"))
            "env_rename" -> return api("POST", "/environments/${enc(a.path("name").asText())}/rename", fields("to"))
            "env_delete" -> { api("DELETE", "/environments/${enc(a.path("name").asText())}"); return "삭제됨" }
            "flow_run_input" -> return if (a.hasNonNull("vars")) api("PUT", "/flows/${id()}/run-input", fields("vars")) else get("/flows/${id()}/run-input")
            "secret_list" -> return get("/secrets").map { mapOf("name" to it.path("name").asText(), "environment" to it.path("environment").asText("*")) }
            "plugin_list" -> return mapOf("transforms" to get("/transforms"), "codecs" to get("/codecs"))
            "transform_preview" -> return api("POST", "/transforms/${id()}/preview", fields("inputs", "config", "environment").apply { if (!has("inputs")) set<JsonNode>("inputs", mapper.createObjectNode()); if (!has("config")) set<JsonNode>("config", mapper.createObjectNode()) })
            "plugin_script_list" -> return api("GET", "/plugins/scripts", query = mapOf("status" to a.text("status")))
            "plugin_script_get" -> return script()
            "plugin_script_try" -> return api("POST", "/plugins/scripts/try", fields("source", "inputs", "config", "value", "fn", "direction", "message", "bytesB64", "environment"))
            "plugin_script_upsert" -> return if (a.hasNonNull("id")) api("PUT", "/plugins/scripts/${script().path("id").asText()}", fields("name", "source")) else api("POST", "/plugins/scripts", fields("name", "source"))
            "plugin_script_submit" -> return api("POST", "/plugins/scripts/${script().path("id").asText()}/${if (a.path("action").asText() == "withdraw") "withdraw" else "submit"}")
            "plugin_script_wait" -> {
                var current = script()
                val deadline = System.nanoTime() + Duration.ofSeconds(a.path("timeoutSec").asLong(45)).toNanos()
                while (current.path("status").asText() == "PENDING" && System.nanoTime() < deadline) { Thread.sleep(3000); current = get("/plugins/scripts/${current.path("id").asText()}") }
                return current
            }
            "http_request" -> return httpRequest(c, a)
            else -> error("알 수 없는 도구: $name")
        }
    }

    private fun httpRequest(c: McpInvocation, args: ObjectNode): JsonNode {
        val location = args.path("executionAgent").asText("server")
        require(location in setOf("local", "server")) { "executionAgent는 local 또는 server여야 합니다" }
        val body = mapper.createObjectNode().put("executionAgent", location)
        listOf("method", "url", "headers", "body", "timeoutSec").forEach { key -> args.get(key)?.let { body.set<JsonNode>(key, it) } }
        if (!body.has("method")) body.put("method", "GET")
        if (body.hasNonNull("body") && !body.path("body").isTextual) {
            body.put("body", mapper.writeValueAsString(body.path("body")))
            val headers = body.get("headers") as? ObjectNode ?: mapper.createObjectNode().also { body.set<JsonNode>("headers", it) }
            if (headers.fieldNames().asSequence().none { it.equals("Content-Type", true) }) headers.put("Content-Type", "application/json")
        }
        // Deliberately no direct HTTP to the supplied URL and no bearer injection into target headers.
        return rest.api(c.copy(target = location, workspaceId = if (location == c.target) c.workspaceId else null), "POST", "/agent/http-request", body)
    }

    private fun startRun(c: McpInvocation, flowId: String, body: ObjectNode): JsonNode {
        val pc = c.target == "server" && needsPc(c, flowId)
        return rest.api(c, "POST", "/flows/${enc(flowId)}/runs", body, viaPc = c.target == "local" || pc, remoteOnPc = pc)
    }

    private fun needsPc(c: McpInvocation, flowId: String, versionId: String? = null): Boolean {
        val detail = rest.api(c, "GET", "/flows/${enc(flowId)}")
        val graph = if (versionId != null) {
            val versions = rest.api(c, "GET", "/flows/${enc(flowId)}/versions")
            val version = versions.firstOrNull { it.path("id").asText() == versionId }
                ?: error("원본 실행 버전을 확인하지 못했습니다. 다시 실행하지 않습니다")
            rest.api(c, "GET", "/flows/${enc(flowId)}/versions/${version.path("versionNo").asInt()}")
        } else detail.path("graph")
        return graph.path("nodes").any { it.path("executionAgent").asText() == "local" || it.path("reqMode").asText() == "client" || it.path("type").asText().lowercase() in setOf("form", "input") }
    }

    private fun waitDone(c: McpInvocation, started: JsonNode, seconds: Int): Any {
        var ex = started
        val id = ex.path("id").asText()
        val deadline = System.nanoTime() + Duration.ofSeconds(seconds.toLong()).toNanos()
        while (isPending(ex) && System.nanoTime() < deadline) {
            Thread.sleep(500)
            ex = try { rest.api(c, "GET", "/executions/${enc(id)}") }
            catch (error: Exception) { return mapOf("executionId" to id, "안내" to "실행은 계속될 수 있습니다. 재실행하지 말고 execution_get으로 확인하세요", "조회 오류" to error.message) }
        }
        return executionOutput(ex, false)
    }

    private fun executionOutput(ex: JsonNode, full: Boolean): Any = mapOf("execution" to (if (full) ex else ex.deepCopy<JsonNode>().apply {
        path("nodes").forEach { row -> if (row is ObjectNode) listOf("request", "response", "requestText", "responseText", "output").forEach { key ->
            row.get(key)?.let { value ->
                val text = if (value.isTextual) value.asText() else mapper.writeValueAsString(value)
                if (text.length > 2000) row.put(key, text.take(2000) + "… (전체 값은 execution_get full=true)")
            }
        } }
    }), "안내" to when {
        ex.path("pendingAgent").path("status").asText() == "UNKNOWN" -> "결과가 불명확합니다. 자동 재실행하지 마세요."
        ex.hasNonNull("pendingForm") -> "Windows 앱 화면에서 실제 폼 제출이 필요합니다."
        ex.hasNonNull("pendingInput") -> "execution_resume의 values로 사용자 입력을 전달할 수 있습니다."
        ex.hasNonNull("pendingClient") -> "PC 브라우저 호출 대기입니다. execution_resume은 온라인 PC 에이전트에 호출을 위임합니다."
        isPending(ex) -> "진행 중입니다. execution_get으로 확인하세요."
        else -> "상태와 노드별 요청/응답을 확인하세요."
    }, "full" to full)

    private fun workspace(c: McpInvocation, reference: String?): JsonNode {
        val list = rest.api(c.copy(workspaceId = null), "GET", "/workspaces")
        val ref = reference.orEmpty().trim()
        if (ref.isEmpty() || c.target == "local" && ref in setOf("local", "개인")) return list.firstOrNull { it.path("kind").asText() == if (c.target == "local") "PERSONAL" else "PUBLIC" } ?: error("기본 워크스페이스가 없습니다")
        list.firstOrNull { it.path("id").asText() == ref }?.let { return it }
        return named(list, ref, listOf("name"), "워크스페이스", ignoreCase = true)
    }

    private fun folders(c: McpInvocation): List<JsonNode> {
        val list = rest.api(c, "GET", "/folders").toList()
        val byId = list.associateBy { it.path("id").asText() }
        fun path(row: JsonNode, visited: Set<String>): String {
            val id = row.path("id").asText(); require(id !in visited) { "폴더 경로가 순환합니다" }
            val parent = byId[row.path("parentId").asText()]
            return (parent?.let { path(it, visited + id) + "/" } ?: "") + row.path("name").asText()
        }
        return list.map { (it.deepCopy<JsonNode>() as ObjectNode).put("path", path(it, emptySet())) }
    }

    private fun folder(c: McpInvocation, ref: String?): JsonNode? {
        if (ref.isNullOrBlank() || ref == "/") return null
        val fs = folders(c)
        val exact = fs.filter { it.path("id").asText() == ref || it.path("path").asText() == ref }
        val matches = exact.ifEmpty { fs.filter { it.path("name").asText() == ref } }
        require(matches.size == 1) { if (matches.isEmpty()) "폴더 없음: $ref" else "폴더 이름이 겹칩니다. 경로 또는 id를 지정하세요: ${matches.joinToString { it.path("path").asText() }}" }
        return matches.single()
    }

    private fun named(list: JsonNode, ref: String, keys: List<String>, label: String, ignoreCase: Boolean = false): JsonNode {
        val matches = list.filter { item -> keys.any { item.path(it).asText().equals(ref, ignoreCase) } }
        require(ref.isNotBlank() && matches.size == 1) { if (matches.size > 1) "$label 이름이 겹칩니다. id를 지정하세요" else "$label 없음: $ref" }
        return matches.single()
    }

    private fun render(value: Any?): String = if (value is String) value else mapper.writerWithDefaultPrettyPrinter().writeValueAsString(value)
    private fun JsonNode.text(key: String): String? = get(key)?.takeUnless(JsonNode::isNull)?.asText()
    private fun enc(value: String) = McpRestClient.segment(value)

    companion object {
        fun isPending(ex: JsonNode): Boolean = ex.path("status").asText() in setOf("RUNNING", "PENDING") || ex.path("status").asText() == "WAITING" && ex.hasNonNull("pendingAgent") && ex.path("pendingAgent").path("status").asText() != "UNKNOWN"
    }
}
