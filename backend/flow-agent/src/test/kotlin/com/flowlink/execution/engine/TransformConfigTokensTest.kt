package com.flowlink.execution.engine

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.agent.AgentNodeExecutor
import com.flowlink.agent.AgentNodeRequest
import com.flowlink.agent.AgentResources
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.GraphNode
import com.flowlink.protocol.ProtocolResources
import com.flowlink.transform.FlowTransform
import com.flowlink.transform.TransformRegistry
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import java.util.Optional
import java.util.UUID

class TransformConfigTokensTest {
    @Test fun `실제 변환 엔진은 설정의 환경 시크릿 토큰을 풀고 결과 로그만 마스킹한다`() {
        val json = JsonService(jacksonObjectMapper())
        val tokens = TokenResolver(json)
        val workspace = UUID.randomUUID()
        val received = mutableListOf<Map<String, String>>()
        val transform = object : FlowTransform {
            override fun id() = "config-check"
            override fun label() = "설정 해석 검증"
            override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> {
                received += config
                return mapOf("result" to "${config.getValue("label")} / ${config.getValue("credential")}")
            }
        }
        val registry = mock(TransformRegistry::class.java)
        `when`(registry.get("config-check", workspace)).thenReturn(Optional.of(transform))
        `when`(registry.fingerprint("config-check", workspace)).thenReturn("approved-version")
        val resources = mock(AgentResources::class.java)
        `when`(resources.workspaceScope(workspace.toString())).thenReturn(workspace)
        `when`(resources.environmentExists("dev", workspace)).thenReturn(true)
        `when`(resources.environment("dev", workspace)).thenReturn(mapOf("STAGE" to "개발"))
        `when`(resources.secrets("dev", workspace)).thenReturn(mapOf("TOKEN" to "central-sensitive-key"))
        val engine = FlowExecutor(tokens, ExpressionEvaluator(tokens), mock(HttpNodeExecutor::class.java), json, registry,
            TcpNodeExecutor(tokens, mock(ProtocolResources::class.java)))
        val executor = AgentNodeExecutor(engine, resources, json, tokens, registry)
        val node = json.mapper().readValue("""{"id":"transform","type":"transform","executionAgent":"server","transformId":"config-check",
            "config":{"label":"환경 {{STAGE@env}}","credential":"{{TOKEN@secret}}","literal":"변경 없는 값"}}""", GraphNode::class.java)
        val request = AgentNodeRequest(UUID.randomUUID(), UUID.randomUUID(), node, workspaceId = workspace.toString(), envName = "dev", crossBoundary = false)
        val result = executor.execute(request).result
        assertThat(result.ok).isTrue()
        assertThat(received).containsExactly(mapOf("label" to "환경 개발", "credential" to "central-sensitive-key", "literal" to "변경 없는 값"))
        assertThat(result.value).isEqualTo(mapOf("result" to "환경 개발 / central-sensitive-key"))
        assertThat(result.storedValue).isEqualTo(mapOf("result" to "환경 개발 / ••••••"))
        assertThat(result.responseText).contains("환경 개발").doesNotContain("central-sensitive-key")
        assertThat(node.config?.get("credential")).isEqualTo("{{TOKEN@secret}}")

        val missing = executor.execute(request.copy(node = node.copy(config = node.config.orEmpty() + ("label" to "{{MISSING@env}}")))).result
        assertThat(missing.ok).isFalse()
        assertThat(missing.responseText).contains("목적지 자원이 없습니다")
        assertThat(received).hasSize(1)
    }
}
