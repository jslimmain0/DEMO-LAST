package com.flowlink.execution

import com.flowlink.core.graph.GraphNode
import com.flowlink.core.graph.NodeType
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/** 단일 실행 노드 선택 — 편집 중 노드(override)가 같은 id 면 그것을, 아니면 저장본을 쓴다. */
class SingleNodeOverrideTest {
    private fun node(id: String, name: String) = GraphNode(
        id = id, name = name, type = NodeType.SET.name.lowercase(), cat = null,
        method = null, baseUrl = null, baseUrlBound = null, path = null,
        bodyType = null, respType = null, rawBody = null, jsonRaw = null,
        paramsRaw = null, rawParams = null, headersRaw = null, rawHeaders = null,
        reqMode = null, charset = null, fields = null, outputs = null,
        vars = null, condition = null, switchActive = null,
        formAction = null, formMethod = null,
        waitTimeoutSec = null, callbackRespType = null, callbackRespBody = null,
        waitMsg = null, waitFields = null,
        transformId = null, config = null,
        tcpHost = null, tcpPort = null, tcpEncoding = null, tcpTimeoutMs = null,
        tcpPrefixLength = null, tcpPrefixIncludesSelf = null, tcpRequest = null, tcpResponse = null,
        x = null, y = null,
    )

    @Test
    fun `override 가 같은 id 면 override`() {
        assertThat(ExecutionService.pickSingleNode(node("n1", "saved"), node("n1", "edited"), "n1")!!.name).isEqualTo("edited")
    }

    @Test
    fun `override id 가 다르면 저장본`() {
        assertThat(ExecutionService.pickSingleNode(node("n1", "saved"), node("n2", "edited"), "n1")!!.name).isEqualTo("saved")
    }

    @Test
    fun `저장본이 없어도 override 로 실행 가능(미저장 새 노드)`() {
        assertThat(ExecutionService.pickSingleNode(null, node("n1", "edited"), "n1")!!.name).isEqualTo("edited")
        assertThat(ExecutionService.pickSingleNode(null, null, "n1")).isNull()
    }
}
