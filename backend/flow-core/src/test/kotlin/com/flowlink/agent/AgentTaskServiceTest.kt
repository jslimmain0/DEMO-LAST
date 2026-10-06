package com.flowlink.agent

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.crypto.CryptoProvider
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.engine.NodeResult
import com.flowlink.execution.engine.StateCrypto
import com.flowlink.execution.engine.TokenResolver
import com.flowlink.workspace.WorkspaceService
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.autoconfigure.EnableAutoConfiguration
import org.springframework.boot.autoconfigure.domain.EntityScan
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.mock.mockito.MockBean
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Import
import org.springframework.data.jpa.repository.config.EnableJpaRepositories
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@SpringBootTest(classes = [AgentTaskServiceTest.Config::class], properties = [
    "spring.datasource.url=jdbc:h2:mem:agenttasks;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop", "spring.flyway.enabled=false",
])
class AgentTaskServiceTest {
    @Configuration
    @EnableAutoConfiguration
    @EntityScan(basePackageClasses = [AgentTask::class, com.flowlink.core.domain.Execution::class])
    @EnableJpaRepositories(basePackageClasses = [AgentTaskRepository::class, com.flowlink.core.repository.ExecutionRepository::class])
    @Import(AgentTaskService::class, JsonService::class, TokenResolver::class)
    class Config {
        @Bean fun mapper(): ObjectMapper = jacksonObjectMapper()
        @Bean fun crypto(): CryptoProvider = StateCrypto("agent-task-test-key")
    }
    @Autowired lateinit var tasks: AgentTaskService
    @Autowired lateinit var repo: AgentTaskRepository
    @Autowired lateinit var mapper: ObjectMapper
    @Autowired lateinit var executions: com.flowlink.core.repository.ExecutionRepository
    @Autowired lateinit var checkpoints: com.flowlink.core.repository.ExecutionSuspensionRepository
    @MockBean lateinit var workspace: WorkspaceService
    @MockBean lateinit var executor: AgentNodeExecutor

    @BeforeEach fun prepare() {
        TenantContext.clear(); repo.deleteAll(); checkpoints.deleteAll(); executions.deleteAll()
        Mockito.`when`(workspace.currentUsername()).thenReturn("dev")
        Mockito.`when`(workspace.isApproved("dev")).thenReturn(true)
        Mockito.`when`(workspace.supportsWorkspace(null)).thenReturn(true)
        Mockito.`when`(workspace.resolveId("public")).thenReturn(null)
        Mockito.`when`(executor.runtime).thenReturn("server")
    }
    private fun request(agent: String): AgentNodeRequest = AgentNodeRequest(UUID.randomUUID(), UUID.randomUUID(),
        mapper.readValue("""{"id":"node","type":"http","executionAgent":"$agent"}""", GraphNode::class.java),
        allowedOutputs = listOf("amount", "ok"), allowedRequestKeys = listOf("orderId"))
    private fun create(request: AgentNodeRequest): AgentTaskView {
        val execution = com.flowlink.core.domain.Execution.start(TenantContext.DEFAULT_TENANT, UUID.randomUUID(), UUID.randomUUID(),
            com.flowlink.core.domain.TriggerType.MANUAL, "dev", null, request.executionId).apply { markWaiting(); agentDeviceId = "device-1" }
        executions.save(execution)
        checkpoints.save(com.flowlink.core.domain.ExecutionSuspension.of(request.executionId, TenantContext.DEFAULT_TENANT, "node", "{}",
            """{"pendingAgent":{"taskId":"${request.taskId}"}}""", null))
        return tasks.create(request, AgentRunOptions(request.executionId, "device-1", "server", "dev", "public", null))
    }
    private fun awaitStatus(id: UUID, expected: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(6)
        while (tasks.get(id).status != expected && System.nanoTime() < deadline) Thread.sleep(10)
        assertThat(tasks.get(id).status).isEqualTo(expected)
    }

    @Test fun `동시 execute와 응답 유실 재요청이 외부 호출을 반복하지 않는다`() {
        val request = request("server")
        create(request)
        val claim = tasks.claim(request.taskId, AgentClaim("device-1"))
        assertThat(claim.request).isNull() // 서버 환경·명세를 PC에 보낼 이유가 없다.
        assertThat(tasks.get(request.taskId).claimToken).isNull()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        Mockito.`when`(executor.execute(request)).thenAnswer {
            assertThat(Thread.currentThread().isVirtual).isTrue()
            assertThat(TenantContext.getTenantId()).isEqualTo(TenantContext.DEFAULT_TENANT)
            entered.countDown(); release.await(4, TimeUnit.SECONDS)
            AgentNodeResult(NodeResult.ok(200, null, null, mapOf("amount" to 42)), 1)
        }
        val lease = AgentLease("device-1", claim.claimToken!!)
        tasks.execute(request.taskId, lease)
        assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue()
        try {
            val callers = java.util.concurrent.Executors.newFixedThreadPool(3)
            try { callers.invokeAll(List(6) { java.util.concurrent.Callable { tasks.execute(request.taskId, lease).status } }).forEach {
                assertThat(it.get()).isEqualTo("RUNNING")
            } } finally { callers.shutdownNow() }
        } finally { release.countDown() }
        awaitStatus(request.taskId, "SUCCEEDED")
        tasks.execute(request.taskId, lease)
        Mockito.verify(executor, Mockito.times(1)).execute(request)
    }

    @Test fun `장치와 계정 lease를 강제하고 외부 결과를 허용 키로 제한한다`() {
        val request = request("local")
        create(request)
        assertThatThrownBy { tasks.claim(request.taskId, AgentClaim("another-device")) }.isInstanceOf(ForbiddenException::class.java)
        val claim = tasks.claim(request.taskId, AgentClaim("device-1"))
        assertThat(claim.request).isEqualTo(request)
        assertThat(tasks.get(request.taskId).request).isNull()
        val raw = NodeResult.okHttp(200, "private-request", "private-response",
            mapOf("amount" to 42, "ok" to true, "secret" to "must-not-pass"), mapOf("orderId" to "a", "extra" to "must-not-pass"))
        assertThatThrownBy { tasks.complete(request.taskId, AgentCompletion("device-1", "wrong-lease", raw)) }.isInstanceOf(ForbiddenException::class.java)
        val completion = AgentCompletion("device-1", claim.claimToken!!, raw, 5)
        tasks.complete(request.taskId, completion)
        val result = tasks.result(request.taskId)!!.result
        assertThat(result.value as Map<*, *>).hasSize(2)
        assertThat(result.reqValues!!.keys).containsExactly("orderId")
        assertThat(mapper.writeValueAsString(result)).doesNotContain("must-not-pass", "private-request", "private-response")
        tasks.complete(request.taskId, completion.copy(result = raw.copy(value = mapOf("amount" to 99))))
        assertThat((tasks.result(request.taskId)!!.result.value as Map<*, *>)["amount"]).isEqualTo(42)
        Mockito.`when`(workspace.currentUsername()).thenReturn("another-user")
        assertThatThrownBy { tasks.get(request.taskId) }.isInstanceOf(ForbiddenException::class.java)
    }

    @Test fun `대기 상한 거절은 외부 호출 없이 실패 결과를 커밋한다`() {
        val workers = org.springframework.test.util.ReflectionTestUtils.getField(tasks, "workers") as java.util.concurrent.Executor
        val entered = CountDownLatch(4); val release = CountDownLatch(1); val drained = CountDownLatch(104)
        try {
            repeat(104) { workers.execute {
                entered.countDown()
                try { release.await() } finally { drained.countDown() }
            } }
            assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue()
            val request = request("server")
            create(request)
            val claim = tasks.claim(request.taskId, AgentClaim("device-1"))
            tasks.execute(request.taskId, AgentLease("device-1", claim.claimToken!!))
            assertThat(tasks.get(request.taskId).status).isEqualTo("FAILED")
            assertThat(tasks.result(request.taskId)!!.result.httpStatus).isEqualTo(429)
            Mockito.verify(executor, Mockito.never()).execute(request)
        } finally {
            release.countDown()
            assertThat(drained.await(5, TimeUnit.SECONDS)).isTrue()
        }
    }

    @Test fun `재시작 중 요청은 UNKNOWN으로 복구하고 ACK 뒤 위임 본문을 제거한다`() {
        val request = request("server")
        val delegated = tasks.delegate(AgentDelegation("device-1", request))
        val lease = AgentLease("device-1", delegated.claimToken!!)
        val row = repo.findById(request.taskId).orElseThrow()
        row.status = "RUNNING"; repo.saveAndFlush(row)
        tasks.recover()
        assertThat(tasks.get(request.taskId).status).isEqualTo("UNKNOWN")
        tasks.execute(request.taskId, lease)
        Mockito.verify(executor, Mockito.never()).execute(request)
        tasks.ack(request.taskId, lease)
        val cleaned = repo.findById(request.taskId).orElseThrow()
        assertThat(cleaned.status).isEqualTo("ACKED")
        assertThat(cleaned.requestData).isNull(); assertThat(cleaned.resultData).isNull()
        tasks.ack(request.taskId, lease)
    }

    @Test fun `원본 공간 권한으로 다른 팀의 환경을 실행할 수 없다`() {
        val target = UUID.randomUUID()
        val request = request("server").copy(workspaceId = target.toString())
        Mockito.`when`(workspace.resolveId(target.toString())).thenReturn(target)
        Mockito.`when`(workspace.supportsWorkspace(target)).thenReturn(true)
        Mockito.doThrow(ForbiddenException("다른 팀 접근 거부")).`when`(workspace).requireWrite("dev", target)
        create(request)
        val claim = tasks.claim(request.taskId, AgentClaim("device-1"))
        assertThatThrownBy { tasks.execute(request.taskId, AgentLease("device-1", claim.claimToken!!)) }
            .isInstanceOf(ForbiddenException::class.java)
        assertThat(tasks.get(request.taskId).status).isEqualTo("CLAIMED")
        Mockito.verify(executor, Mockito.never()).execute(request)
    }

    @Test fun `위임 패킷에 환경과 시크릿 저장소를 통째로 보낼 수 없다`() {
        val request = request("server").copy(seeds = mapOf("secret" to mapOf("password" to "must-stay-local")))
        assertThatThrownBy { tasks.delegate(AgentDelegation("device-1", request)) }.isInstanceOf(BadRequestException::class.java)
        assertThat(repo.existsById(request.taskId)).isFalse()
    }

    @Test fun `취소됐거나 다음 체크포인트로 넘어간 실행의 작업을 시작하지 않는다`() {
        for (cancelled in listOf(true, false)) {
            val request = request("server")
            create(request)
            val claim = tasks.claim(request.taskId, AgentClaim("device-1"))
            if (cancelled) {
                val execution = executions.findById(request.executionId).orElseThrow().apply { markCancelled("사용자 취소") }
                executions.saveAndFlush(execution)
            } else {
                val checkpoint = checkpoints.findById(request.executionId).orElseThrow().apply { outcomeJson = """{"pendingAgent":{"taskId":"${UUID.randomUUID()}"}}""" }
                checkpoints.saveAndFlush(checkpoint)
            }
            assertThat(tasks.execute(request.taskId, AgentLease("device-1", claim.claimToken!!)).status).isEqualTo("ACKED")
            Mockito.verify(executor, Mockito.never()).execute(request)
        }
    }

    @Test fun `취소된 실행을 뒤늦게 claim해도 PC 작업 패킷을 주지 않는다`() {
        val request = request("local")
        create(request)
        val execution = executions.findById(request.executionId).orElseThrow().apply { markCancelled("사용자 취소") }
        executions.saveAndFlush(execution)

        val claim = tasks.claim(request.taskId, AgentClaim("device-1"))

        assertThat(claim.status).isEqualTo("ACKED")
        assertThat(claim.request).isNull()
        assertThat(repo.findById(request.taskId).orElseThrow().requestData).isNull()
        Mockito.verify(executor, Mockito.never()).execute(request)
    }
}
