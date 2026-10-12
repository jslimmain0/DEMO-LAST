package com.flowlink.core.graph

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * 워크플로 그래프 전체 — FlowVersion.graphJson 의 타입드 뷰.
 * 프로토타입 export 포맷({@code {version,name,nodes,edges,imports}})과 호환.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class FlowGraph(
    val version: Int?,
    val name: String?,
    val nodes: List<GraphNode>?,
    val edges: List<GraphEdge>?,
    @get:com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    val resourceWorkspaceId: String? = null,
) {
    fun nodesOrEmpty(): List<GraphNode> = nodes ?: emptyList()

    fun edgesOrEmpty(): List<GraphEdge> = edges ?: emptyList()
}
