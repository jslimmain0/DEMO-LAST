package com.flowlink.core.graph

import com.flowlink.common.error.BadRequestException
import com.flowlink.execution.config.ExecutionProperties
import org.springframework.stereotype.Component

/**
 * 저장 시점의 정적 그래프 검증. (실행 시점 안전 검사는 엔진에서 추가로 수행)
 * 빈 그래프(새 워크플로)는 허용한다.
 */
@Component
class GraphValidator(
    private val props: ExecutionProperties
) {

    fun validate(graph: FlowGraph) {
        val nodes = graph.nodesOrEmpty()
        if (nodes.size > props.maxNodesPerRun) {
            throw BadRequestException(
                "노드 수가 상한(" + props.maxNodesPerRun + ")을 초과했습니다: " + nodes.size
            )
        }

        val ids = HashSet<String>()
        for (n in nodes) {
            if (n.id == null || n.id.isBlank()) {
                throw BadRequestException("id 없는 노드가 있습니다.")
            }
            if (!ids.add(n.id)) {
                throw BadRequestException("중복된 노드 id: " + n.id)
            }
        }

        for (e in graph.edgesOrEmpty()) {
            if (e.from == null || e.to == null) {
                throw BadRequestException("from/to 없는 엣지가 있습니다: " + e.id)
            }
            if (!ids.contains(e.from) || !ids.contains(e.to)) {
                throw BadRequestException("존재하지 않는 노드를 가리키는 엣지: " + e.id)
            }
        }
    }
}
