package com.flowlink.execution

import com.flowlink.agent.*
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.*
import com.flowlink.core.repository.*
import com.flowlink.execution.dto.ResumeRequest
import com.flowlink.execution.dto.RunRequest
import com.flowlink.execution.engine.NodeResult
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.TestPropertySource
import org.springframework.boot.test.mock.mockito.SpyBean
import org.mockito.Mockito
import java.time.Duration
import java.util.UUID
import org.awaitility.Awaitility.await

@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:managed-execution;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop", "flowlink.execution.ssrf.allow-loopback=true",
])
class ManagedExecutionIntegrationTest {
    @Autowired lateinit var executions: ExecutionService
    @Autowired lateinit var flows: FlowRepository
    @Autowired lateinit var versions: FlowVersionRepository
    @Autowired lateinit var rows: ExecutionRepository
    @Autowired lateinit var suspensions: ExecutionSuspensionRepository
    @Autowired lateinit var nodes: NodeExecutionRepository
    @Autowired lateinit var tasks: AgentTaskService
    @Autowired lateinit var taskRows: AgentTaskRepository
    @Autowired lateinit var json: JsonService
    @Autowired lateinit var workspaces: com.flowlink.workspace.WorkspaceService
    @Autowired lateinit var environments: com.flowlink.environment.EnvironmentService
    @Autowired lateinit var plugins: com.flowlink.plugin.PluginScriptService
    @SpyBean lateinit var crypto: com.flowlink.common.crypto.CryptoProvider

    private fun withHttpTarget(block: (String) -> Unit) {
        val server = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            exchange.requestBody.use { it.readAllBytes() }
            val body = """{"copied":7,"answer":"ok"}""".toByteArray()
            exchange.responseHeaders.set("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try { block("http://127.0.0.1:" + server.address.port) } finally { server.stop(0) }
    }

    private val device = "test-pc"
    private fun flow(vararg body: String): UUID {
        val all = listOf("""{"id":"start","type":"start"}""") + body.toList() + """{"id":"end","type":"end"}"""
        val ids = all.map { json.readTree(it).path("id").asText() }
        val edges = ids.zipWithNext().mapIndexed { i, (from, to) -> """{"id":"e$i","from":"$from","to":"$to"}""" }
        val flow = flows.save(Flow.create(TenantContext.SHARED_FLOW_TENANT, "관리 실행 ${UUID.randomUUID()}", null))
        versions.save(FlowVersion.create(flow.id, 1, flow.name,
            """{"nodes":[${all.joinToString(",")}],"edges":[${edges.joinToString(",")}] }""", null, "dev"))
        flow.currentVersion = 1; flows.save(flow)
        return flow.id
    }
    private fun request(id: UUID = UUID.randomUUID()) = RunRequest(null, null, null, null,
        agentDeviceId = device, clientExecutionId = id, agentEnvironments = mapOf("local" to ""))
    private fun pending(id: UUID, node: String): AgentTaskView {
        await().atMost(Duration.ofSeconds(10)).untilAsserted {
            assertThat(executions.get(id).pendingAgent?.nodeId).isEqualTo(node)
        }
        return tasks.claim(executions.get(id).pendingAgent!!.taskId, AgentClaim(device))
    }
    private fun complete(task: AgentTaskView, value: Any?): AgentCompletion {
        val completion = AgentCompletion(device, task.claimToken!!, NodeResult.ok(null, null, null, value))
        tasks.complete(task.taskId, completion)
        return completion
    }
    private fun succeeded(id: UUID) {
        await().atMost(Duration.ofSeconds(10)).untilAsserted { assertThat(executions.get(id).status).isEqualTo(ExecutionStatus.SUCCEEDED) }
    }

    @Test fun `PC와 서버 노드를 번갈아 처리하고 중복 결과를 한 번만 적용한다`() = withHttpTarget { target ->
        val id = flow(
            """{"id":"pc","type":"http","executionAgent":"local","baseUrl":"http://unused.test","outputs":[{"key":"amount"}]}""",
            """{"id":"remote","type":"http","executionAgent":"server","baseUrl":"$target","method":"POST","bodyType":"json","fields":{"body":[{"key":"amount","value":"{{amount@pc}}"}]},"outputs":[{"key":"copied"}]}""",
            """{"id":"last","type":"http","executionAgent":"local","baseUrl":"http://unused.test","fields":{"body":[{"key":"copied","value":"{{copied@remote}}"}]},"outputs":[{"key":"result"}]}""",
        )
        val request = request()
        val run = executions.run(id, request)
        assertThat(run.pendingAgent!!.nodeId).isEqualTo("pc")
        assertThat(suspensions.findById(run.id)).isPresent
        assertThat(executions.run(id, request).id).isEqualTo(run.id)
        assertThat(taskRows.findByExecutionId(run.id)).hasSize(1)
        val first = pending(run.id, "pc")
        val completion = complete(first, mapOf("amount" to 7))
        val remote = pending(run.id, "remote")
        assertThat(remote.request).isNull() // 서버에서 해석하는 입력 묶음은 PC에 전달하지 않는다.
        tasks.execute(remote.taskId, AgentLease(device, remote.claimToken!!))
        val last = pending(run.id, "last")
        assertThat(last.request!!.values["remote"]).isEqualTo(mapOf("copied" to 7))
        tasks.complete(first.taskId, completion)
        executions.agentTaskCompleted(AgentTaskCompleted(first.taskId, run.id, TenantContext.getTenantId()))
        complete(last, mapOf("result" to true))
        succeeded(run.id)
        assertThat(nodes.findByExecutionIdOrderBySeqAsc(run.id).filter { it.nodeId == "pc" }).hasSize(1)
        assertThat(nodes.findByExecutionIdOrderBySeqAsc(run.id).first { it.nodeId == "remote" }.executionAgent).isEqualTo("server")
        assertThat(suspensions.findById(run.id)).isEmpty
        assertThat(taskRows.findByExecutionId(run.id)).allSatisfy { task ->
            assertThat(task.status).isEqualTo("ACKED")
            assertThat(task.requestData).isNull(); assertThat(task.resultData).isNull()
        }
        val savedFlow = flows.findById(id).get()
        versions.save(FlowVersion.create(id, 2, savedFlow.name, versions.findByFlowIdAndVersionNo(id, 1).get().graphJson, null, "dev"))
        savedFlow.currentVersion = 2; flows.save(savedFlow)
        assertThat(executions.run(id, request).id).isEqualTo(run.id)
        assertThrows<BadRequestException> { executions.run(id, request.copy(input = json.readTree("{\"changed\":true}"))) }
    }

    @Test fun `서버 전용 관리 실행은 브라우저나 PC 없이 다음 작업까지 진행한다`() = withHttpTarget { target ->
        val id = flow("""{"id":"remote","type":"http","executionAgent":"server","baseUrl":"$target","outputs":[{"key":"answer"}]}""")
        val run = executions.run(id, null)
        succeeded(run.id)
        assertThat(rows.findById(run.id).get().agentDeviceId).isEqualTo("server")
        assertThat(nodes.findByExecutionIdOrderBySeqAsc(run.id).first { it.nodeId == "remote" }.outputJson).contains("ok")
    }

    @Test fun `WAIT 도착 전 콜백을 보관하고 작업 완료 후 자동 소비한다`() {
        val id = flow(
            """{"id":"pc","type":"http","executionAgent":"local","baseUrl":"http://unused.test"}""",
            """{"id":"callback","type":"wait","waitTimeoutSec":30,"callbackRespType":"json","callbackRespBody":"{\"accepted\":true}"}""",
            """{"id":"last","type":"set","executionAgent":"local","vars":[{"key":"paid","value":"{{paid@callback}}"}]}""",
        )
        val run = executions.run(id, request())
        val response = executions.recordWaitCallback(run.id, "callback", "POST", emptyMap(), "{\"paid\":true}")
        assertThat(response.body).isEqualTo("{\"accepted\":true}")
        complete(pending(run.id, "pc"), emptyMap<String, Any>())
        executions.recordWaitCallback(run.id, "callback", "POST", emptyMap(), "{\"paid\":false}")
        succeeded(run.id)
        assertThat(nodes.findByExecutionIdOrderBySeqAsc(run.id).first { it.nodeId == "last" }.outputJson).contains("true")
        assertThat(nodes.findByExecutionIdOrderBySeqAsc(run.id).filter { it.nodeId == "callback" }).hasSize(1)
    }

    @Test fun `확인 불가 작업을 취소한 뒤 늦은 결과가 와도 실행되지 않는다`() {
        val id = flow("""{"id":"pc","type":"http","executionAgent":"local","baseUrl":"http://unused.test"}""")
        val run = executions.run(id, request())
        val task = pending(run.id, "pc")
        tasks.unknown(task.taskId, AgentUnknown(device, task.claimToken!!, "connection lost"))
        assertThat(executions.get(run.id).pendingAgent!!.status).isEqualTo("UNKNOWN")
        executions.resume(run.id, ResumeRequest("pc", null, null, "중단", null, null, null, true, null))
        complete(task, mapOf("late" to true))
        assertThat(executions.get(run.id).status).isEqualTo(ExecutionStatus.CANCELLED)
        assertThat(suspensions.findById(run.id)).isEmpty
        assertThat(nodes.findByExecutionIdOrderBySeqAsc(run.id).none { it.nodeId == "pc" }).isTrue()
    }

    @Test fun `PC 없는 서버 실행의 로컬 노드를 실행 전에 거절한다`() {
        val id = flow("""{"id":"pc","type":"http","executionAgent":"local","baseUrl":"http://unused.test"}""")
        assertThrows<BadRequestException> { executions.run(id, null) }
        assertThat(rows.findByFlowIdOrderByStartedAtDesc(id, org.springframework.data.domain.PageRequest.of(0, 10))).isEmpty()
    }

    @Test fun `단일 노드 관리 실행은 상류 수동 입력만 사용하고 다른 노드는 실행하지 않는다`() {
        val id = flow(
            """{"id":"first","type":"set","executionAgent":"server","vars":[{"key":"amount","value":"wrong"}]}""",
            """{"id":"selected","type":"set","executionAgent":"server","vars":[{"key":"copy","value":"{{amount@first}}"}]}""",
        )
        val run = executions.run(id, RunRequest(null, null, null, null,
            upstream = json.readTree("{\"first\":{\"amount\":17}}"), onlyNodeId = "selected"))
        succeeded(run.id)
        val records = nodes.findByExecutionIdOrderBySeqAsc(run.id)
        assertThat(records).hasSize(1)
        assertThat(records.single().nodeId).isEqualTo("selected")
        assertThat(records.single().outputJson).contains("17")
    }

    @Test fun `경로 스위치 단일 테스트는 선택 트랙만 출력하고 다른 노드는 실행하지 않는다`() {
        val id = flow(
            """{"id":"selected","type":"switch","switchActive":"2","switchPorts":[{"id":"1","label":"처음"},{"id":"2","label":"선택"}]}""",
            """{"id":"next","type":"assert","condition":"false"}""",
        )
        val run = executions.run(id, RunRequest(null, null, null, null, onlyNodeId = "selected"))
        succeeded(run.id)
        val records = nodes.findByExecutionIdOrderBySeqAsc(run.id)
        assertThat(records).hasSize(1)
        assertThat(records.single().nodeId).isEqualTo("selected")
        assertThat(json.readTree(records.single().outputJson!!).path("branch").asText()).isEqualTo("2")
        assertThat(taskRows.findByExecutionId(run.id)).isEmpty()
    }

    @Test fun `단일 테스트 재실행은 원래 버전 입력 환경 상류 값과 선택 노드를 보존한다`() {
        val id = flow(
            """{"id":"first","type":"set","vars":[{"key":"amount","value":"wrong"}]}""",
            """{"id":"selected","type":"set","vars":[{"key":"copy","value":"{{amount@first}}"},{"key":"stage","value":"{{STAGE@env}}"},{"key":"order","value":"{{order@input}}"}]}""",
        )
        val request = RunRequest(json.readTree("{\"order\":\"original\"}"), json.readTree("{\"STAGE\":\"DEV\"}"), null, null,
            upstream = json.readTree("{\"first\":{\"amount\":17}}"), onlyNodeId = "selected",
            agentDeviceId = device, clientExecutionId = UUID.randomUUID(), agentEnvironments = mapOf("server:public" to ""))
        val original = executions.run(id, request)
        succeeded(original.id)
        val saved = rows.findById(original.id).get().inputJson!!
        assertThat(saved).contains("encryptedOptions").doesNotContain("\"onlyNodeId\"", "\"STAGE\"", "\"upstream\"", device)
        val originalVersion = versions.findById(original.flowVersionId).get()
        versions.save(FlowVersion.create(id, 2, originalVersion.name, originalVersion.graphJson, null, "dev"))
        flows.findById(id).get().let { it.currentVersion = 2; flows.save(it) }

        val rerun = executions.rerun(original.id, RunRequest(null, null, null, null))
        succeeded(rerun.id)
        assertThat(rerun.id).isNotEqualTo(original.id)
        assertThat(rerun.flowVersionId).isEqualTo(original.flowVersionId)
        assertThat(rows.findById(rerun.id).get().agentDeviceId).isEqualTo("server")
        val records = nodes.findByExecutionIdOrderBySeqAsc(rerun.id)
        assertThat(records).hasSize(1)
        assertThat(records.single().nodeId).isEqualTo("selected")
        val output = json.readTree(records.single().outputJson!!)
        assertThat(output.path("copy").asInt()).isEqualTo(17)
        assertThat(output.path("stage").asText()).isEqualTo("DEV")
        assertThat(output.path("order").asText()).isEqualTo("original")
        assertThat(json.toJson(executions.get(rerun.id))).doesNotContain("encryptedOptions", "FlowLink.ExecutionRequest.v1")
        assertThat(json.toJson(executions.listForFlow(id, 10))).doesNotContain("encryptedOptions", "FlowLink.ExecutionRequest.v1")
    }

    @Test fun `계산 노드의 과거 목적지는 무시하고 전체 단일 관리 실행이 같은 환경을 사용한다`() {
        val id = flow(
            """{"id":"selected","type":"set","executionAgent":"local","agentWorkspaceId":"missing-team","agentEnvironment":"missing-env","agentMock":"missing-mock","agentOutputs":[],"vars":[{"key":"marker","value":"{{MARKER@env}}"},{"key":"amount","value":"{{amount@input}}"}]}""",
            """{"id":"check","type":"assert","executionAgent":"local","agentEnvironment":"missing-env","condition":"{{amount@selected}} == 17"}""",
        )
        val saved = versions.findByFlowIdAndVersionNo(id, 1).get().graphJson
        val req = RunRequest(json.readTree("""{"amount":17}"""), json.readTree("""{"MARKER":"OWNER"}"""), null, null)
        val run = executions.run(id, req)
        succeeded(run.id)
        assertThat(rows.findById(run.id).get().agentDeviceId).isNull()
        assertThat(taskRows.findByExecutionId(run.id)).isEmpty()
        val records = nodes.findByExecutionIdOrderBySeqAsc(run.id)
        assertThat(records.first { it.nodeId == "selected" }.outputJson).contains("OWNER", "17")
        assertThat(records.filter { it.nodeId in setOf("selected", "check") }).allSatisfy { assertThat(it.executionAgent).isNull() }

        val destinationOverrides = req.copy(agentEnvironments = mapOf("local" to "missing-env"))
        val single = executions.runSingleNode(id, "selected", destinationOverrides)
        assertThat(single.ok).isTrue()
        assertThat(single.output).isEqualTo(mapOf("marker" to "OWNER", "amount" to 17))
        val managed = executions.run(id, destinationOverrides.copy(onlyNodeId = "selected"))
        succeeded(managed.id)
        assertThat(taskRows.findByExecutionId(managed.id)).isEmpty()
        val managedRecords = nodes.findByExecutionIdOrderBySeqAsc(managed.id)
        assertThat(managedRecords).hasSize(1)
        assertThat(managedRecords.single().outputJson).contains("OWNER", "17")
        assertThat(managedRecords.single().executionAgent).isNull()
        assertThat(versions.findByFlowIdAndVersionNo(id, 1).get().graphJson).isEqualTo(saved)
    }

    @Test fun `다음 체크포인트 저장 실패는 결과 이력과 작업 생성을 롤백하고 저장된 결과만 재적용한다`() {
        val id = flow(
            """{"id":"first","type":"http","executionAgent":"local","baseUrl":"http://unused.test"}""",
            """{"id":"next","type":"http","executionAgent":"local","baseUrl":"http://unused.test"}""",
        )
        val run = executions.run(id, request())
        val failed = java.util.concurrent.atomic.AtomicBoolean()
        Mockito.doAnswer { invocation ->
            val text = invocation.getArgument<String>(0)
            if (text.contains("\"pendingNodeId\":\"next\"") && failed.compareAndSet(false, true))
                throw IllegalStateException("injected checkpoint failure")
            invocation.callRealMethod()
        }.`when`(crypto).encrypt(Mockito.anyString())
        val first = pending(run.id, "first")
        complete(first, emptyMap<String, Any>())
        await().atMost(Duration.ofSeconds(1)).untilTrue(failed)
        assertThat(taskRows.findById(first.taskId).get().status).isEqualTo("SUCCEEDED")
        assertThat(suspensions.findById(run.id).get().pendingNodeId).isEqualTo("first")
        assertThat(nodes.findByExecutionIdOrderBySeqAsc(run.id).none { it.nodeId == "first" }).isTrue()
        assertThat(taskRows.findByExecutionId(run.id)).hasSize(1)
        complete(pending(run.id, "next"), emptyMap<String, Any>())
        succeeded(run.id)
        assertThat(nodes.findByExecutionIdOrderBySeqAsc(run.id).filter { it.nodeId == "first" }).hasSize(1)
    }

    @Test fun `진행 중인 팀 실행의 저장 공간을 삭제하거나 이관할 수 없다`() {
        val team = workspaces.createTeam("실행보호 ${UUID.randomUUID()}")
        val target = workspaces.createTeam("이관대상 ${UUID.randomUUID()}")
        val id = flow("""{"id":"pc","type":"http","executionAgent":"local","baseUrl":"http://unused.test"}""")
        flows.findById(id).get().let { it.workspaceId = UUID.fromString(team.id); flows.save(it) }
        val run = executions.run(id, request())
        assertThrows<BadRequestException> { workspaces.delete(UUID.fromString(team.id), UUID.fromString(target.id)) }
        executions.resume(run.id, ResumeRequest("pc", null, null, null, null, null, null, true, null))
    }

    @Test fun `다른 실행기 환경을 선택하지 않으면 공통으로 실행하지 않는다`() {
        val id = flow("""{"id":"pc","type":"http","executionAgent":"local","baseUrl":"http://unused.test"}""")
        val run = executions.run(id, request().copy(agentEnvironments = emptyMap()))
        assertThat(run.status).isEqualTo(ExecutionStatus.FAILED)
        assertThat(run.error).contains("목적지 환경")
        assertThat(taskRows.findByExecutionId(run.id)).isEmpty()
    }

    @Test fun `팀 흐름에서 서버 공통 환경을 골라도 같은 이름의 팀 변수와 합치지 않는다`() {
        val team = workspaces.createTeam("환경 출처 ${UUID.randomUUID()}")
        val name = "shared-${UUID.randomUUID()}"
        environments.put(name, mapOf("marker" to "CENTRAL"), "public")
        environments.put(name, mapOf("marker" to "TEAM", "teamOnly" to "private-team-value"), team.id)
        val id = flow(
            """{"id":"copy","type":"set","vars":[{"key":"marker","value":"{{marker@env}}"}]}""",
            """{"id":"check","type":"assert","condition":"{{teamOnly@env}} == 'private-team-value'"}""",
        )
        flows.findById(id).get().let { it.workspaceId = UUID.fromString(team.id); flows.save(it) }
        val run = executions.run(id, RunRequest(null, json.readTree("{}"), name, null,
            envSource = "server", resourceWorkspaceId = "public"))
        assertThat(executions.get(run.id).status).isEqualTo(ExecutionStatus.FAILED)
        assertThat(executions.get(run.id).error).contains("teamOnly")
        val value = nodes.findByExecutionIdOrderBySeqAsc(run.id).first { it.nodeId == "copy" }.outputJson
        assertThat(value).contains("CENTRAL").doesNotContain("TEAM", "private-team-value")
    }

    @Test fun `서버 흐름의 PC 환경은 명시한 변수 묶음만 사용한다`() {
        val id = flow("""{"id":"copy","type":"set","vars":[{"key":"marker","value":"{{marker@env}}"}]}""")
        val run = executions.run(id, request().copy(envName = "only-on-pc", env = json.readTree("""{"marker":"PC"}"""),
            envSource = "local", resourceWorkspaceId = "public"))
        succeeded(run.id)
        assertThat(nodes.findByExecutionIdOrderBySeqAsc(run.id).first { it.nodeId == "copy" }.outputJson).contains("PC")
        assertThrows<BadRequestException> { executions.run(id, RunRequest(null, null, "only-on-pc", null, envSource = "local")) }
    }

    @Test fun `PC 작업의 요청 상세를 이력에서 요약으로 덮어쓰지 않는다`() {
        val id = flow("""{"id":"pc","type":"http","executionAgent":"local","baseUrl":"http://unused.test"}""")
        val run = executions.run(id, request().copy(onlyNodeId = "pc"))
        val task = pending(run.id, "pc")
        tasks.complete(task.taskId, AgentCompletion(device, task.claimToken!!,
            NodeResult.ok(200, "POST http://127.0.0.1/orders\nAuthorization: ••••••\n{\"amount\":32100}", "완료", emptyMap<String, Any?>())))
        succeeded(run.id)
        val record = nodes.findByExecutionIdOrderBySeqAsc(run.id).single()
        assertThat(record.requestText).contains("POST http://127.0.0.1/orders", "Authorization: ••••••", "32100")
    }

    @Test fun `저장된 공통 자원 선택은 UI 실행 옵션 없이도 팀 흐름의 중앙 변환을 실행한다`() {
        val pluginId = "shared-${UUID.randomUUID()}"
        val plugin = plugins.create(com.flowlink.plugin.PluginScriptDtos.SaveRequest("공통 변환",
            "({id:'$pluginId',label:'공통',inputs:[],outputs:[{key:'result'}],apply(){return {result:'CENTRAL_PLUGIN'}}})"))
        plugins.submit(plugin.id); plugins.approve(plugin.id)
        val team = workspaces.createTeam("공통 그래프 ${UUID.randomUUID()}")
        val id = flow("""{"id":"convert","type":"transform","transformId":"$pluginId","outputs":[{"key":"result"}]}""")
        flows.findById(id).get().let { it.workspaceId = UUID.fromString(team.id); flows.save(it) }
        val old = versions.findByFlowIdAndVersionNo(id, 1).get()
        val graph = json.readTree(old.graphJson) as com.fasterxml.jackson.databind.node.ObjectNode
        graph.put("resourceWorkspaceId", "public")
        versions.save(FlowVersion.create(id, 2, old.name, graph.toString(), null, "dev"))
        flows.findById(id).get().let { it.currentVersion = 2; flows.save(it) }
        val run = executions.run(id, null)
        succeeded(run.id)
        val record = nodes.findByExecutionIdOrderBySeqAsc(run.id).first { it.nodeId == "convert" }
        assertThat(record.outputJson).contains("CENTRAL_PLUGIN")
        assertThat(record.executionAgent).isEqualTo("server")
        assertThrows<BadRequestException> { executions.runSingleNode(id, "convert") }
    }
}
