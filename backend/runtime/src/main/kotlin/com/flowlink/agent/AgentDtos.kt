package com.flowlink.agent

import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.engine.NodeResult
import java.util.UUID

data class AgentRunOptions(
    val executionId: UUID, val deviceId: String, val ownerAgent: String,
    val username: String, val workspaceId: String?, val envName: String?,
    val serverUrl: String? = null, val login: String? = null,
    val dependencyHashes: Map<String, Map<String, String>> = emptyMap(),
    val agentEnvironments: Map<String, String> = emptyMap(),
)

/** 바인딩에 필요한 값만 전달한다. 환경과 시크릿은 목적지에서 해석한다. */
data class AgentNodeRequest(
    val taskId: UUID, val executionId: UUID, val node: GraphNode,
    val values: Map<String, Any?> = emptyMap(), val seeds: Map<String, Any?> = emptyMap(),
    val workspaceId: String? = null, val envName: String? = null,
    val crossBoundary: Boolean = true,
    val allowedOutputs: List<String> = emptyList(), val allowedRequestKeys: List<String> = emptyList(),
    val dependencyHashes: Map<String, String> = emptyMap(),
)

data class AgentNodeResult(val result: NodeResult, val durationMs: Long)
data class PendingAgent(
    val taskId: UUID, val nodeId: String, val nodeName: String?, val agent: String,
    val status: String = "PENDING", val error: String? = null, val deviceId: String? = null,
)
data class AgentTaskView(
    val taskId: UUID, val executionId: UUID, val nodeId: String, val agent: String,
    val status: String, val deviceId: String, val error: String? = null,
    val request: AgentNodeRequest? = null, val claimToken: String? = null,
    val result: NodeResult? = null, val durationMs: Long = 0,
)
data class AgentClaim(val deviceId: String)
data class AgentLease(val deviceId: String, val claimToken: String)
data class AgentCompletion(val deviceId: String, val claimToken: String, val result: NodeResult, val durationMs: Long = 0)
data class AgentUnknown(val deviceId: String, val claimToken: String, val error: String)
data class AgentDelegation(val deviceId: String, val request: AgentNodeRequest)
data class AgentRunStarted(val executionId: UUID, val tenant: String, val serverUrl: String? = null, val login: String? = null)
data class AgentTaskCompleted(val taskId: UUID, val executionId: UUID, val tenant: String)
