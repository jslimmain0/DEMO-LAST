package com.flowlink.core.graph;

import com.flowlink.common.error.BadRequestException;
import com.flowlink.execution.config.ExecutionProperties;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.Set;

/**
 * 저장 시점의 정적 그래프 검증. (실행 시점 안전 검사는 엔진에서 추가로 수행)
 * 빈 그래프(새 워크플로)는 허용한다.
 */
@Component
public class GraphValidator {

    private final ExecutionProperties props;

    public GraphValidator(ExecutionProperties props) {
        this.props = props;
    }

    public void validate(FlowGraph graph) {
        var nodes = graph.nodesOrEmpty();
        if (nodes.size() > props.maxNodesPerRun()) {
            throw new BadRequestException(
                    "노드 수가 상한(" + props.maxNodesPerRun() + ")을 초과했습니다: " + nodes.size());
        }

        Set<String> ids = new HashSet<>();
        for (GraphNode n : nodes) {
            if (n.id() == null || n.id().isBlank()) {
                throw new BadRequestException("id 없는 노드가 있습니다.");
            }
            if (!ids.add(n.id())) {
                throw new BadRequestException("중복된 노드 id: " + n.id());
            }
        }

        for (GraphEdge e : graph.edgesOrEmpty()) {
            if (e.from() == null || e.to() == null) {
                throw new BadRequestException("from/to 없는 엣지가 있습니다: " + e.id());
            }
            if (!ids.contains(e.from()) || !ids.contains(e.to())) {
                throw new BadRequestException("존재하지 않는 노드를 가리키는 엣지: " + e.id());
            }
        }
    }
}
