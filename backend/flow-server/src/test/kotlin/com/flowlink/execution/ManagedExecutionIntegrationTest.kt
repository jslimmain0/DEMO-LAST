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
    @SpyBean lateinit var crypto: com.flowlink.common.crypto.CryptoProvider

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

    @Test fun `PC와 서버 노드를 번갈아 처리하고 중복 결과를 한 번만 적용한다`() {
        val id = flow(
            """{"id":"pc","type":"set","executionAgent":"local","vars":[{"key":"amount","value":"7"}]}""",
            """{"id":"remote","type":"set","executionAgent":"server","vars":[{"key":"copied","value":"{{amount@pc}}"}]}""",
            """{"id":"last","type":"assert","executionAgent":"local","condition":"{{copied@remote}} == 7"}""",
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

    @Test fun `서버 전용 관리 실행은 브라우저나 PC 없이 다음 작업까지 진행한다`() {
        val id = flow("""{"id":"remote","type":"set","executionAgent":"server","vars":[{"key":"answer","value":"ok"}]}""")
        val run = executions.run(id, null)
        succeeded(run.id)
        assertThat(rows.findById(run.id).get().agentDeviceId).isEqualTo("server")
        assertThat(nodes.findByExecutionIdOrderBySeqAsc(run.id).first { it.nodeId == "remote" }.outputJson).contains("ok")
    }

    @Test fun `WAIT 도착 전 콜백을 보관하고 작업 완료 후 자동 소비한다`() {
        val id = flow(
            """{"id":"pc","type":"set","executionAgent":"local","vars":[]}""",
            """{"id":"callback","type":"wait","waitTimeoutSec":30,"callbackRespType":"json","callbackRespBody":"{\"accepted\":true}"}""",
            """{"id":"last","type":"set","executionAgent":"local","vars":[{"key":"paid","value":"{{paid@callback}}"}]}""",
        )
        val run = executions.run(id, request())
        val response = executions.recordWaitCallback(run.id, "callback", "POST", emptyMap(), "{\"paid\":true}")
        assertThat(response.body).isEqualTo("{\"accepted\":true}")
        complete(pending(run.id, "pc"), emptyMap<String, Any>())
        val last = pending(run.id, "last")
        assertThat(last.request!!.values["callback"]).isEqualTo(mapOf("paid" to true))
        executions.recordWaitCallback(run.id, "callback", "POST", emptyMap(), "{\"paid\":false}")
        complete(last, mapOf("paid" to true))
        succeeded(run.id)
        assertThat(nodes.findByExecutionIdOrderBySeqAsc(run.id).filter { it.nodeId == "callback" }).hasSize(1)
    }

    @Test fun `확인 불가 작업을 취소한 뒤 늦은 결과가 와도 실행되지 않는다`() {
        val id = flow("""{"id":"pc","type":"set","executionAgent":"local","vars":[]}""")
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
        val id = flow("""{"id":"pc","type":"set","executionAgent":"local","vars":[]}""")
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

    @Test fun `다음 체크포인트 저장 실패는 결과 이력과 작업 생성을 롤백하고 저장된 결과만 재적용한다`() {
        val id = flow(
            """{"id":"first","type":"set","executionAgent":"local","vars":[]}""",
            """{"id":"next","type":"set","executionAgent":"local","vars":[]}""",
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
        val id = flow("""{"id":"pc","type":"set","executionAgent":"local","vars":[]}""")
        flows.findById(id).get().let { it.workspaceId = UUID.fromString(team.id); flows.save(it) }
        val run = executions.run(id, request())
        assertThrows<BadRequestException> { workspaces.delete(UUID.fromString(team.id), UUID.fromString(target.id)) }
        executions.resume(run.id, ResumeRequest("pc", null, null, null, null, null, null, true, null))
    }

    @Test fun `다른 실행기 환경을 선택하지 않으면 공통으로 실행하지 않는다`() {
        val id = flow("""{"id":"pc","type":"set","executionAgent":"local","vars":[]}""")
        val run = executions.run(id, request().copy(agentEnvironments = emptyMap()))
        assertThat(run.status).isEqualTo(ExecutionStatus.FAILED)
        assertThat(run.error).contains("목적지 환경")
        assertThat(taskRows.findByExecutionId(run.id)).isEmpty()
    }
}
