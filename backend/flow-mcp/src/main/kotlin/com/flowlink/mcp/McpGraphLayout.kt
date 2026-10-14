package com.flowlink.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode

/** 표시 좌표만 정한다. 실행 순서·바인딩·노드 설정은 유지한다. */
internal object McpGraphLayout {
    const val GUIDE = "MCP 새 워크플로는 layoutDirection=TB인 위→아래 배치입니다. 연결점도 위·아래를 사용하고 선형 단계는 같은 열, T/F·스위치 분기는 포트 순서대로 좌우, 합류는 가운데로 모읍니다. 카드 사이 여백을 유지하고 START와 END의 중심을 주 흐름에 맞춥니다. 기존 수정은 좌표·방향을 유지합니다. flow_upsert layout=compact-tree로 재배치하거나 layout=preserve로 입력 배치를 유지합니다. ASSERT는 사용자가 명시한 업무 성공 조건·독립적인 인수 조건에만 최소로 사용합니다. 매 호출마다 HTTP 200·값 존재·프레임/ACK 검증을 반복하는 노드를 만들지 마세요. 기존 사용자가 만든 검증은 보존합니다."

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
        graph.path("edges").sortedWith(compareBy<JsonNode>({ it.path("from").asText() }, { edge ->
            val source = byId[edge.path("from").asText()]
            val port = edge.path("fromPort").asText("out")
            when (source?.path("type")?.asText()) {
                "if" -> if (port == "true") 0 else 1
                "switch" -> source.path("switchPorts").indexOfFirst { it.path("id").asText() == port }.let { if (it < 0) Int.MAX_VALUE else it }
                else -> 0
            }
        }, { it.path("to").asText() })).forEach { edge ->
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
        val center = 44
        val positions = mutableMapOf<String, Pair<Int, Int>>()
        nodes.filter { it.path("type").asText() == "start" }.forEachIndexed { i, node -> positions[node.path("id").asText()] = center to (44 + i * 198) }
        var y = 198
        body.forEach { (_, rows) ->
            val desired = rows.associate { node ->
                val id = node.path("id").asText()
                val previous = parents.getValue(id)
                val anchor = previous.mapNotNull { positions[it]?.first }.average().let { if (it.isNaN()) center.toDouble() else it }
                val siblings = previous.singleOrNull()?.let { outgoing.getValue(it).toList() }.orEmpty()
                id to anchor + if (siblings.size > 1) (siblings.indexOf(id) - (siblings.size - 1) / 2.0) * 308 else 0.0
            }
            val sorted = rows.sortedWith(compareBy({ desired.getValue(it.path("id").asText()) }, { it.path("id").asText() }))
            val placed = mutableMapOf<String, Int>()
            var previousX: Int? = null
            sorted.forEach { node ->
                val id = node.path("id").asText()
                val x = maxOf(desired.getValue(id).toInt(), previousX?.plus(308) ?: Int.MIN_VALUE)
                placed[id] = x; previousX = x
            }
            val correction = (desired.values.average() - placed.values.average()).toInt()
            placed.forEach { (id, x) -> positions[id] = (x + correction) to y }
            y += rows.maxOf { node -> if (node.path("type").asText() == "switch") 76 + maxOf(2, node.path("switchPorts").size()) * 26 else 112 } + 66
        }
        nodes.filter { it.path("type").asText() == "end" }.forEachIndexed { i, node -> positions[node.path("id").asText()] = center to (y + i * 132) }
        val offset = 44 - (positions.values.minOfOrNull { it.first } ?: 44)
        return graph.deepCopy<JsonNode>().also { result -> result.path("nodes").forEach { node ->
            positions[node.path("id").asText()]?.let { (x, y) ->
                val terminal = node.path("type").asText() in setOf("start", "end")
                (node as ObjectNode).put("x", x + offset + if (terminal) 85 else 0).put("y", y)
            }
        }; (result as ObjectNode).put("layoutDirection", "TB") }
    }
}
