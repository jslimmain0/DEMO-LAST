package com.flowlink.transform

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.host.CentralTransformRequest
import com.flowlink.workspace.WorkspaceService
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.mockito.Mockito.*
import java.util.Optional

class CentralTransformControllerTest {
    private val workspace = mock(WorkspaceService::class.java)
    private val registry = mock(TransformRegistry::class.java)
    private val controller = CentralTransformController(workspace, registry)
    private fun approved() {
        `when`(workspace.currentUsername()).thenReturn("alice")
        `when`(workspace.isApproved("alice")).thenReturn(true)
    }

    @Test fun `central transform RPC requires approved public access and a PC device`() {
        assertThrows<ForbiddenException> { controller.catalog("pc") }
        approved()
        assertThrows<BadRequestException> { controller.catalog(null) }
        doThrow(ForbiddenException("viewer")).`when`(workspace).requireWrite("alice", null)
        assertThrows<ForbiddenException> { controller.catalog("pc") }
        verifyNoInteractions(registry)
    }

    @Test fun `catalog contains metadata only and invocation uses actual wire values under the approved fingerprint`() {
        approved()
        val transform = object : FlowTransform {
            override fun id() = "decorate"
            override fun label() = "꾸미기"
            override fun apply(inputs: Map<String, String>, config: Map<String, String>) = mapOf("result" to config.getValue("prefix") + inputs.getValue("input"))
        }
        `when`(registry.list(null)).thenReturn(listOf(transform))
        `when`(registry.get("decorate", null)).thenReturn(Optional.of(transform))
        `when`(registry.fingerprint("decorate", null)).thenReturn("v1")
        val catalog = controller.catalog("pc")
        assertThat(catalog.headers.cacheControl).isEqualTo("no-store")
        assertThat(catalog.body!!.single().fingerprint).isEqualTo("v1")
        val metadata = jacksonObjectMapper().valueToTree<com.fasterxml.jackson.databind.JsonNode>(catalog.body)
        assertThat(metadata.findValues("source")).isEmpty()
        assertThat(metadata.findValues("script")).isEmpty()
        val result = controller.invoke(CentralTransformRequest("decorate", "v1", mapOf("input" to "wire-value"), mapOf("prefix" to "secret:")), "pc")
        assertThat(result.headers.cacheControl).isEqualTo("no-store")
        assertThat(result.body!!.outputs).containsEntry("result", "secret:wire-value")
        `when`(registry.fingerprint("decorate", null)).thenReturn("v2")
        assertThat(assertThrows<BadRequestException> { controller.invoke(CentralTransformRequest("decorate", "v1"), "pc") }.message).contains("승인 버전")
    }

    @Test fun `invalid inputs and plugin failures never disclose raw secret error details`() {
        approved()
        val transform = mock(FlowTransform::class.java)
        `when`(registry.fingerprint("broken", null)).thenReturn("v1")
        `when`(registry.get("broken", null)).thenReturn(Optional.of(transform))
        assertThrows<BadRequestException> { controller.invoke(CentralTransformRequest("broken", "v1", (0..200).associate { "$it" to "value" }), "pc") }
        verifyNoInteractions(transform)
        `when`(transform.apply(emptyMap(), emptyMap())).thenThrow(IllegalStateException("secret-password"))
        assertThat(assertThrows<BadRequestException> { controller.invoke(CentralTransformRequest("broken", "v1"), "pc") }.message)
            .contains("서버 변환에 실패").doesNotContain("secret-password")
    }
}
