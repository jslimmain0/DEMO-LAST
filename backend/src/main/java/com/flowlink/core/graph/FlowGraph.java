package com.flowlink.core.graph;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

/**
 * 워크플로 그래프 전체 — FlowVersion.graphJson 의 타입드 뷰.
 * 프로토타입 export 포맷({@code {version,name,nodes,edges,imports}})과 호환.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record FlowGraph(
        Integer version,
        String name,
        List<GraphNode> nodes,
        List<GraphEdge> edges
) {
    public List<GraphNode> nodesOrEmpty() {
        return nodes == null ? List.of() : nodes;
    }

    public List<GraphEdge> edgesOrEmpty() {
        return edges == null ? List.of() : edges;
    }
}
