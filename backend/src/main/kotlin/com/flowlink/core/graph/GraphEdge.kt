package com.flowlink.core.graph

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * 노드 간 연결. fromPort는 분기 노드(if)의 'true'/'false' 또는 기본 'out'.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class GraphEdge(
    val id: String?,
    val from: String?,
    val fromPort: String?,
    val to: String?
) {
    fun fromPortOrDefault(): String =
        if (fromPort == null || fromPort.isBlank()) "out" else fromPort
}
