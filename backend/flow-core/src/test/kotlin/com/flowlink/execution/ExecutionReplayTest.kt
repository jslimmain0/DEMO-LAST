package com.flowlink.execution

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.crypto.CryptoProvider
import com.flowlink.common.error.BadRequestException
import com.flowlink.execution.dto.RunRequest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.Base64
import java.util.UUID

class ExecutionReplayTest {
    private val mapper = jacksonObjectMapper()
    private val crypto = object : CryptoProvider {
        override fun encrypt(plain: String) = Base64.getEncoder().encodeToString(plain.toByteArray())
        override fun decrypt(encoded: String) = String(Base64.getDecoder().decode(encoded))
    }
    private val replay = ExecutionReplay(mapper, crypto)
    private fun original() = RunRequest(
        mapper.readTree("""{"order":"original"}"""), mapper.readTree("""{"TOKEN":"sensitive-env-value"}"""), "dev", 1,
        upstream = mapper.readTree("""{"first":{"amount":17}}"""), onlyNodeId = "selected",
        agentDeviceId = "old-device", clientExecutionId = UUID.randomUUID(),
        agentDependencies = mapOf("selected" to mapOf("protocol" to "hash")), agentEnvironments = mapOf("server:team" to "destination-dev"),
        envSource = "server", resourceWorkspaceId = "public",
    )

    @Test fun `재실행 조건은 암호화하고 실행 식별자와 장치는 재사용하지 않는다`() {
        val request = original()
        val stored = replay.store(request)
        assertThat(stored).doesNotContain("sensitive-env-value", "old-device", "destination-dev", "selected", request.clientExecutionId.toString())
        assertThat(mapper.readTree(stored).path("input")).isEqualTo(request.input)
        val restored = replay.restore(stored, true, 4, null)
        assertThat(restored.input).isEqualTo(request.input)
        assertThat(restored.versionNo).isEqualTo(4)
        assertThat(restored.onlyNodeId).isEqualTo("selected")
        assertThat(restored.upstream).isEqualTo(request.upstream)
        assertThat(restored.env).isEqualTo(request.env)
        assertThat(restored.envName).isEqualTo("dev")
        assertThat(restored.agentEnvironments).isEqualTo(request.agentEnvironments)
        assertThat(restored.agentDependencies).isEqualTo(request.agentDependencies)
        assertThat(restored.envSource).isEqualTo("server")
        assertThat(restored.resourceWorkspaceId).isEqualTo("public")
        assertThat(restored.agentDeviceId).isNull()
        assertThat(restored.clientExecutionId).isNull()
    }

    @Test fun `빈 재실행 요청은 원조건을 유지하고 명시한 새 옵션만 변경한다`() {
        val request = original()
        val stored = replay.store(request)
        val empty = replay.restore(stored, true, 1, RunRequest(null, null, null, null))
        assertThat(empty.envName).isEqualTo("dev")
        assertThat(empty.onlyNodeId).isEqualTo("selected")
        assertThat(empty.agentEnvironments).isEqualTo(request.agentEnvironments)
        val newId = UUID.randomUUID()
        val changed = replay.restore(stored, true, 1, RunRequest(mapper.readTree("{\"order\":\"ignored\"}"),
            mapper.readTree("{\"TOKEN\":\"new\"}"), "", 99, upstream = mapper.readTree("{}"),
            agentDeviceId = "new-device", clientExecutionId = newId, agentEnvironments = mapOf("server:team" to ""), envSource = "local"))
        assertThat(changed.input).isEqualTo(request.input)
        assertThat(changed.versionNo).isEqualTo(1)
        assertThat(changed.envName).isEmpty()
        assertThat(changed.env!!.path("TOKEN").asText()).isEqualTo("new")
        assertThat(changed.upstream!!.size()).isZero()
        assertThat(changed.agentEnvironments).containsEntry("server:team", "")
        assertThat(changed.envSource).isEqualTo("local")
        assertThat(changed.resourceWorkspaceId).isEqualTo("public")
        assertThat(changed.agentDeviceId).isEqualTo("new-device")
        assertThat(changed.clientExecutionId).isEqualTo(newId)
    }

    @Test fun `구형 전체실행 입력은 읽되 범위가 소실된 관리 이력이나 손상된 옵션은 재실행하지 않는다`() {
        val legacy = replay.restore("{\"order\":\"legacy\"}", false, 2, null)
        assertThat(legacy.input!!.path("order").asText()).isEqualTo("legacy")
        assertThat(legacy.onlyNodeId).isNull()
        assertThrows<BadRequestException> { replay.restore("{\"order\":\"legacy\"}", true, 2, null) }
        assertThrows<BadRequestException> { replay.restore(null, true, 2, null) }
        val broken = mapper.readTree(replay.store(original())) as com.fasterxml.jackson.databind.node.ObjectNode
        broken.put("encryptedOptions", "invalid ciphertext")
        assertThrows<BadRequestException> { replay.restore(mapper.writeValueAsString(broken), true, 2, null) }
        broken.put("marker", "FlowLink.ExecutionRequest.v2")
        assertThrows<BadRequestException> { replay.restore(mapper.writeValueAsString(broken), false, 2, null) }
    }
}
