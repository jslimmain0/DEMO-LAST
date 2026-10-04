package com.flowlink.execution.engine

import com.flowlink.core.domain.NodeExecutionStatus
import com.flowlink.core.graph.GraphNode

/**
 * 노드 1건 완료 시 호출되는 콜백. 구현체(ExecutionService)는 짧은 트랜잭션으로 즉시 영속화해
 * 외부 HTTP 호출 동안 DB 트랜잭션을 길게 잡지 않는다.
 */
fun interface NodeRecorder {
    fun record(node: GraphNode, seq: Int, result: NodeResult, status: NodeExecutionStatus, durationMs: Long)
}
