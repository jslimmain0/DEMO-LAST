package com.flowlink.core.graph

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.execution.config.ExecutionProperties
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class SharedResourceGraphTest {
    private val json = JsonService(com.fasterxml.jackson.module.kotlin.jacksonObjectMapper())
    @Test fun `서버 공통 자원 선택은 기존 그래프 JSON에 보존하고 다른 공간은 거부한다`() {
        val current = json.parseGraph("""{"resourceWorkspaceId":"public","nodes":[],"edges":[]}""")
        assertThat(current.resourceWorkspaceId).isEqualTo("public")
        GraphValidator(ExecutionProperties(null)).validate(current)
        assertThat(json.toJson(current)).contains("\"resourceWorkspaceId\":\"public\"")
        assertThat(json.parseGraph("""{"nodes":[],"edges":[]}""").resourceWorkspaceId).isNull()
        assertThrows<BadRequestException> { GraphValidator(ExecutionProperties(null)).validate(current.copy(resourceWorkspaceId = "private-team")) }
    }
}
