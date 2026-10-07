package com.flowlink.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode

/** 표시 좌표만 정한다. 실행 순서·바인딩·노드 설정은 유지한다. */
internal object McpGraphLayout {
    const val GUIDE = "MCP 새 워크플로의 기본 배치는 위에서 아래로 흐르는 컴팩트한 트리입니다. 분기는 좌우로 벌리고 합류는 아래에 배치합니다. START와 모든 END는 같은 세로 열(동일한 x 좌표)에 둡니다. 기존 워크플로 수정은 좌표를 유지합니다. flow_upsert layout=compact-tree로 다시 배치하거나 layout=preserve로 입력 좌표를 유지할 수 있습니다. 이 MCP 배치 규칙은 일반 flow 가이드의 좌→우 예시보다 우선합니다."

    fun forSave(graph: JsonNode, creating: Boolean, layout: String?): JsonNode {
        require(layout == null || layout in setOf("compact-tree", "preserve")) { "layout은 compact-tree 또는 preserve여야 합니다" }
        if (layout == "preserve" || !creating && layout == null) return graph
        val all = graph.path("nodes")
        if (!all.isArray) return graph
        val nodes = all.filter { it is ObjectNode && it.path("type").asText() !in setOf("note", "group") }
        val byId = nodes.associateBy { it.path("id").asText() }
        if (nodes.isEmpty() || byId.size != nodes.size || byId.containsKey("")) return graph
        val outgoing = byId.keys.associateWith { linkedSetOf<String>() }
        val parents = byId.keys.associateWith { linkedSetOf<String>() }
        graph.path("edges").forEach { edge ->
            val from = edge.path("from").asText(); val to = edge.path("to").asText()
            if (from in byId && to in byId && outgoing.getValue(from).add(to)) parents.getValue(to).add(from)
        }
        val indegree = parents.mapValues { it.value.size }.toMutableMap()
        val rank = byId.keys.associateWith { 0 }.toMutableMap()
        val queue = ArrayDeque(byId.keys.filter { indegree.getValue(it) == 0 })
        var visited = 0
        while (queue.isNotEmpty()) {
            val id = queue.removeFirst(); visited++
            outgoing.getValue(id).forEach { child ->
                rank[child] = maxOf(rank.getValue(child), rank.getValue(id) + 1)
                indegree[child] = indegree.getValue(child) - 1
                if (indegree.getValue(child) == 0) queue.addLast(child)
            }
        }
        // 순환 그래프는 좌표를 바꾸지 않고 REST 검증에 전달한다.
        if (visited != nodes.size) return graph
        val body = nodes.filter { it.path("type").asText() !in setOf("start", "end") }
            .groupBy { maxOf(1, rank.getValue(it.path("id").asText())) }.toSortedMap()
        val center = 44 + ((body.values.maxOfOrNull { it.size } ?: 1) - 1) * 132
        val positions = mutableMapOf<String, Pair<Int, Int>>()
        nodes.filter { it.path("type").asText() == "start" }.forEachIndexed { i, node -> positions[node.path("id").asText()] = center to (44 + i * 198) }
        body.forEach { (depth, rows) ->
            val sorted = rows.sortedBy { node ->
                parents.getValue(node.path("id").asText()).mapNotNull { positions[it]?.first }.average().let { if (it.isNaN()) center.toDouble() else it }
            }
            sorted.forEachIndexed { i, node -> positions[node.path("id").asText()] = (center - (rows.size - 1) * 132 + i * 264) to (44 + depth * 198) }
        }
        val endRow = (body.keys.maxOrNull() ?: 0) + 1
        nodes.filter { it.path("type").asText() == "end" }.forEachIndexed { i, node -> positions[node.path("id").asText()] = center to (44 + (endRow + i) * 198) }
        return graph.deepCopy<JsonNode>().also { result -> result.path("nodes").forEach { node ->
            positions[node.path("id").asText()]?.let { (x, y) -> (node as ObjectNode).put("x", x).put("y", y) }
        } }
    }
}
