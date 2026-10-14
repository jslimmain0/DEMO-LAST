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
    @MockBean lateinit var protocols: com.flowlink.protocol.ProtocolResources

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
        Mockito.`when`(executor.execute(Mockito.eq(request) ?: request, Mockito.eq(listOf("task", "dev", "device-1")) ?: emptyList(), Mockito.any<() -> Boolean>() ?: { true })).thenAnswer {
            assertThat(Thread.currentThread().isVirtual).isTrue()
            assertThat(TenantContext.getTenantId()).isEqualTo(TenantContext.DEFAULT_TENANT)
            assertThat(it.getArgument<() -> Boolean>(2).invoke()).isTrue()
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
        Mockito.verify(executor, Mockito.times(1)).execute(Mockito.eq(request) ?: request, Mockito.eq(listOf("task", "dev", "device-1")) ?: emptyList(), Mockito.any<() -> Boolean>() ?: { true })
    }

    @Test fun `송신 직전 상태 검사는 준비 중 취소된 작업의 송신을 거부한다`() {
        val request = request("server"); create(request)
        val claim = tasks.claim(request.taskId, AgentClaim("device-1"))
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val checked = CountDownLatch(1)
        Mockito.`when`(executor.execute(Mockito.eq(request) ?: request, Mockito.eq(listOf("task", "dev", "device-1")) ?: emptyList(), Mockito.any<() -> Boolean>() ?: { true })).thenAnswer {
            entered.countDown(); release.await(4, TimeUnit.SECONDS)
            assertThat(it.getArgument<() -> Boolean>(2).invoke()).isFalse(); checked.countDown()
            AgentNodeResult(NodeResult.fail(0, null, "보내지 않음"), 0)
        }
        tasks.execute(request.taskId, AgentLease("device-1", claim.claimToken!!))
        assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue()
        try { tasks.cancelExecution(request.executionId) } finally { release.countDown() }
        assertThat(checked.await(3, TimeUnit.SECONDS)).isTrue()
        assertThat(tasks.get(request.taskId).status).isEqualTo("ACKED")
    }

    @Test fun `위임 TCP 연결 종료는 원래 계정과 장치만 정리한다`() {
        val request = request("server")
        tasks.delegate(AgentDelegation("device-1", request))
        tasks.closeTcpDelegations(request.executionId, AgentClaim("device-other"))
        Mockito.verify(executor, Mockito.never()).closeTcpExecution(request.executionId, listOf("task", "dev", "device-1"))
        Mockito.`when`(workspace.currentUsername()).thenReturn("other")
        tasks.closeTcpDelegations(request.executionId, AgentClaim("device-1"))
        Mockito.verify(executor, Mockito.never()).closeTcpExecution(request.executionId, listOf("task", "dev", "device-1"))
        Mockito.`when`(workspace.currentUsername()).thenReturn("dev")
        tasks.closeTcpDelegations(request.executionId, AgentClaim("device-1"))
        Mockito.verify(executor).closeTcpExecution(request.executionId, listOf("task", "dev", "device-1"))
    }

    @Test fun `PC HTTP completion keeps the permitted text body readable on the server`() {
        val request = request("local").copy(crossBoundary = true, allowedOutputs = listOf("body", "httpStatus"))
        create(request)
        val claim = tasks.claim(request.taskId, AgentClaim("device-1"))
        val html = "<html><body>응답 본문</body></html>"
        val result = NodeResult.okHttp(200, "private-request", html, mapOf("body" to html, "httpStatus" to 200), emptyMap())
        tasks.complete(request.taskId, AgentCompletion("device-1", claim.claimToken!!, result, 5))
        val stored = tasks.result(request.taskId)!!.result
        assertThat(stored.responseText).isEqualTo(html)
        assertThat(stored.value).isEqualTo(mapOf("body" to html, "httpStatus" to 200))
        assertThat(stored.requestText).isEqualTo("private-request")
    }

    @Test fun `server HTTP completion preserves masked request headers and body on the PC`() {
        Mockito.`when`(workspace.localRuntime).thenReturn(true)
        Mockito.`when`(executor.runtime).thenReturn("local")
        val request = request("server").copy(crossBoundary = true)
        create(request)
        val claim = tasks.claim(request.taskId, AgentClaim("device-1"))
        val sent = "POST https://synthetic.example/echo\nContent-Type: application/json\nAuthorization: Bearer ••••••\n\n{\"amount\":42,\"token\":\"••••••\"}"
        val result = NodeResult.okHttp(200, sent, "unpermitted-response",
            mapOf("amount" to 42, "ok" to true, "secret" to "must-not-pass"),
            mapOf("orderId" to "order-42", "extra" to "must-not-pass"))
        tasks.complete(request.taskId, AgentCompletion("device-1", claim.claimToken!!, result, 5))
        val stored = tasks.result(request.taskId)!!.result
        assertThat(stored.requestText).isEqualTo(sent)
        assertThat(stored.value).isEqualTo(mapOf("amount" to 42, "ok" to true))
        assertThat(stored.storedValue).isEqualTo(stored.value)
        assertThat(stored.reqValues).isEqualTo(mapOf("orderId" to "order-42"))
        assertThat(mapper.writeValueAsString(stored)).doesNotContain("must-not-pass", "unpermitted-response")
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
        assertThat(result.requestText).isEqualTo("private-request")
        assertThat(mapper.writeValueAsString(result)).doesNotContain("must-not-pass", "private-response")
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

    @Test fun `v2 구형 PC 미확인 또는 명시 미지원은 패킷 전송 없이 종료하고 반복 claim도 재시도하지 않는다`() {
        val spec = mapper.readValue(com.flowlink.assistant.TcpV2Guide.PROTOCOL_EXAMPLE, com.flowlink.protocol.ProtocolSpec::class.java)
        Mockito.`when`(protocols.snapshot("v2", null, null)).thenReturn(com.flowlink.protocol.ResolvedProtocol(spec, com.flowlink.protocol.ProtocolCodec.NO_PLUGINS, "fixed"))
        val cases = listOf(null to "CAPABILITY_UNKNOWN", AgentRuntimeCapabilities(listOf(1), emptyMap()) to "UNSUPPORTED_CAPABILITY",
            AgentRuntimeCapabilities(listOf(1, 2), emptyMap()) to "CAPABILITY_UNKNOWN", AgentRuntimeCapabilities(listOf(1, 2), mapOf("transactionFraming" to "unsupported")) to "UNSUPPORTED_CAPABILITY")
        for ((capabilities, code) in cases) {
            val base = request("local")
            val request = base.copy(node = base.node.copy(type = "tcp", protocolId = "v2"), resourceWorkspaceId = "public")
            create(request)
            val claim = tasks.claim(request.taskId, AgentClaim("device-1", capabilities))
            assertThat(claim.status).isEqualTo("FAILED")
            assertThat(claim.error).startsWith(code)
            assertThat(claim.request).isNull()
            assertThat(claim.claimToken).isNull()
            val repeated = tasks.claim(request.taskId, AgentClaim("device-1", capabilities))
            assertThat(repeated.status).isEqualTo("FAILED")
            assertThat(repeated.request).isNull()
        }
        Mockito.verify(executor, Mockito.never()).execute(Mockito.any(AgentNodeRequest::class.java) ?: request("local"), Mockito.anyList<String>() ?: emptyList(), Mockito.any<() -> Boolean>() ?: { true })
    }

    @Test fun `v2 현재 PC 보고만 작업 패킷을 받고 v1은 보고 생략 계약을 유지한다`() {
        val spec = mapper.readValue(com.flowlink.assistant.TcpV2Guide.PROTOCOL_EXAMPLE, com.flowlink.protocol.ProtocolSpec::class.java)
        Mockito.`when`(protocols.snapshot("v2", null, null)).thenReturn(com.flowlink.protocol.ResolvedProtocol(spec, com.flowlink.protocol.ProtocolCodec.NO_PLUGINS, "fixed"))
        val base = request("local")
        val v2 = base.copy(node = base.node.copy(type = "tcp", protocolId = "v2"), resourceWorkspaceId = "public")
        create(v2)
        val claim = tasks.claim(v2.taskId, AgentClaim("device-1", AgentRuntimeCapabilities(com.flowlink.protocol.ProtocolCapabilities.schemaVersions, com.flowlink.protocol.ProtocolCapabilities.features)))
        assertThat(claim.status).isEqualTo("CLAIMED")
        assertThat(claim.request).isEqualTo(v2)
        assertThat(claim.claimToken).isNotBlank()
        val changed = request("local").let { it.copy(node = it.node.copy(type = "tcp", protocolId = "v2"), resourceWorkspaceId = "public", dependencyHashes = mapOf("protocol" to "old")) }
        create(changed)
        val rejected = tasks.claim(changed.taskId, AgentClaim("device-1", AgentRuntimeCapabilities(com.flowlink.protocol.ProtocolCapabilities.schemaVersions, com.flowlink.protocol.ProtocolCapabilities.features)))
        assertThat(rejected.status).isEqualTo("FAILED")
        assertThat(rejected.error).startsWith("DEFINITION_CHANGED")
        assertThat(rejected.request).isNull()
        val legacySpec = com.flowlink.protocol.ProtocolSpec(framing = com.flowlink.protocol.ProtocolSpec.Framing("fixed", fixedLength = 1), messages = listOf(com.flowlink.protocol.ProtocolSpec.Message("request", fields = listOf(com.flowlink.protocol.ProtocolSpec.Field("value", 1, "ascii")))))
        Mockito.`when`(protocols.snapshot("v1", null, null)).thenReturn(com.flowlink.protocol.ResolvedProtocol(legacySpec, com.flowlink.protocol.ProtocolCodec.NO_PLUGINS))
        val legacyBase = request("local")
        val legacy = legacyBase.copy(node = legacyBase.node.copy(type = "tcp", protocolId = "v1"), resourceWorkspaceId = "public")
        create(legacy)
        assertThat(tasks.claim(legacy.taskId, AgentClaim("device-1")).request).isEqualTo(legacy)
    }

    private fun tcpResultRequest(): AgentNodeRequest = request("local").let { base ->
        base.copy(node = base.node.copy(type = "tcp"), crossBoundary = true,
            allowedOutputs = listOf("amount", "ok", "_tcpTransport.raw"), dependencyHashes = mapOf("protocol" to "a".repeat(64)))
    }

    private fun untrustedTransport(): Map<String, Any?> = mapOf(
        "transportStatus" to "FAILED", "protocolFingerprint" to "untrusted-pc-fingerprint", "bytesB64" to "private-encoded",
        "steps" to listOf(
            mapOf("phase" to "REQUEST", "role" to "must-not-pass", "direction" to "must-not-pass", "status" to "SUCCEEDED", "actualBytes" to 23, "durationMs" to 1, "raw" to "must-not-pass"),
            mapOf("phase" to "RESPONSE", "status" to "SUCCEEDED", "expectedBytes" to 23, "actualBytes" to 23, "durationMs" to 2),
            mapOf("phase" to "RESPONSE_ACK", "status" to "FAILED", "expectedBytes" to 1, "actualBytes" to 0, "errorCode" to "ACK_EOF", "validationMode" to "exact", "error" to "must-not-pass"),
            mapOf("phase" to "must-not-pass", "status" to "FAILED", "errorCode" to "must-not-pass")))

    @Test fun `cross boundary TCP success retains masked output and only accepted transport diagnostics`() {
        val request = tcpResultRequest(); create(request)
        val claim = tasks.claim(request.taskId, AgentClaim("device-1"))
        val raw = NodeResult.okHttp(200, "masked-request", "must-not-pass", mapOf("amount" to 42, "ok" to true, "private" to "must-not-pass"), emptyMap())
            .copy(storedValue = mapOf("amount" to "••••••", "ok" to true, "private" to "must-not-pass", "_tcpTransport" to untrustedTransport()))
        tasks.complete(request.taskId, AgentCompletion("device-1", claim.claimToken!!, raw, 5))
        val result = tasks.result(request.taskId)!!.result
        val stored = mapper.valueToTree<com.fasterxml.jackson.databind.JsonNode>(result.storedValue)
        assertThat(stored.path("amount").asText()).isEqualTo("••••••")
        assertThat(stored.path("_tcpTransport").path("protocolFingerprint").asText()).isEqualTo("a".repeat(64))
        assertThat(stored.path("_tcpTransport").path("steps").size()).isEqualTo(3)
        assertThat(stored.path("_tcpTransport").path("steps")[0].path("direction").asText()).isEqualTo("SEND")
        assertThat(mapper.writeValueAsString(result)).doesNotContain("must-not-pass", "private-encoded", "untrusted-pc-fingerprint")
        assertThat((result.value as Map<*, *>).keys).containsExactly("amount", "ok")
    }

    @Test fun `uncertain ACK keeps permitted partial response and diagnostics without result application or retry`() {
        val request = tcpResultRequest(); create(request)
        val claim = tasks.claim(request.taskId, AgentClaim("device-1"))
        val raw = NodeResult.fail(0, "must-not-pass", "must-not-pass").copy(uncertain = true,
            value = mapOf("amount" to 42, "private" to "must-not-pass"),
            storedValue = mapOf("responseFields" to mapOf("amount" to "••••••", "ok" to true, "private" to "must-not-pass"), "_tcpTransport" to untrustedTransport()))
        val completion = AgentCompletion("device-1", claim.claimToken!!, raw, 5)
        val completed = tasks.complete(request.taskId, completion)
        assertThat(completed.status).isEqualTo("UNKNOWN")
        val retained = completed.result!!
        assertThat(retained.uncertain).isTrue()
        assertThat(retained.value).isNull()
        assertThat(retained.requestText).isNull()
        assertThat(tasks.result(request.taskId)).isNull()
        val pending = mapper.valueToTree<com.fasterxml.jackson.databind.JsonNode>(tasks.pending(request.taskId))
        assertThat(pending.path("diagnostics").path("responseFields").path("amount").asText()).isEqualTo("••••••")
        assertThat(pending.path("diagnostics").path("_tcpTransport").path("steps")[2].path("errorCode").asText()).isEqualTo("ACK_EOF")
        assertThat(pending.toString()).doesNotContain("must-not-pass", "private-encoded", "untrusted-pc-fingerprint")
        assertThat(repo.findById(request.taskId).orElseThrow().resultData).doesNotContain("responseFields", "ACK_EOF")
        assertThat(tasks.claim(request.taskId, AgentClaim("device-1")).request).isNull()
        tasks.complete(request.taskId, completion.copy(result = NodeResult.ok(200, null, null, mapOf("amount" to 99))))
        Mockito.`when`(executor.runtime).thenReturn("local")
        tasks.execute(request.taskId, AgentLease("device-1", claim.claimToken!!))
        assertThat(tasks.get(request.taskId).status).isEqualTo("UNKNOWN")
        assertThat(tasks.result(request.taskId)).isNull()
        Mockito.verify(executor, Mockito.never()).execute(Mockito.any(AgentNodeRequest::class.java) ?: request, Mockito.anyList<String>() ?: emptyList(), Mockito.any<() -> Boolean>() ?: { true })
        Mockito.`when`(workspace.currentUsername()).thenReturn("another-user")
        assertThatThrownBy { tasks.get(request.taskId) }.isInstanceOf(ForbiddenException::class.java)
    }

    @Test fun `same host uncertain TCP retains masked response fields without declared downstream outputs`() {
        val request = request("server").let { it.copy(node = it.node.copy(type = "tcp"), crossBoundary = false, allowedOutputs = emptyList()) }
        create(request)
        val claim = tasks.claim(request.taskId, AgentClaim("device-1"))
        val masked = mapOf("amount" to "••••••", "undeclared" to "captured")
        Mockito.`when`(executor.execute(Mockito.eq(request) ?: request, Mockito.eq(listOf("task", "dev", "device-1")) ?: emptyList(), Mockito.any<() -> Boolean>() ?: { true }))
            .thenReturn(AgentNodeResult(NodeResult.fail(0, null, null).copy(uncertain = true,
                storedValue = mapOf("responseFields" to masked, "_tcpTransport" to untrustedTransport())), 5))
        tasks.execute(request.taskId, AgentLease("device-1", claim.claimToken!!))
        awaitStatus(request.taskId, "UNKNOWN")
        assertThat(tasks.pending(request.taskId).diagnostics!!["responseFields"]).isEqualTo(masked)
        assertThat(tasks.result(request.taskId)).isNull()
        assertThat(mapper.writeValueAsString(tasks.pending(request.taskId))).doesNotContain("private-encoded", "untrusted-pc-fingerprint")
    }
}
