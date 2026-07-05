package com.flowlink.execution.dto

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.core.domain.NodeExecutionStatus
import java.util.UUID

data class NodeExecutionView(
    val id: UUID,
    val nodeId: String,
    val nodeName: String?,
    val nodeType: String?,
    val seq: Int,
    val status: NodeExecutionStatus,
    val httpStatus: Int?,
    val durationMs: Long?,
    val ok: Boolean,
    val requestText: String?,
    val responseText: String?,
    val output: JsonNode?
)
