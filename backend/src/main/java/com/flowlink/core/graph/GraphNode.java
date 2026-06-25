package com.flowlink.core.graph;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

/**
 * 워크플로 그래프의 노드. 프로토타입의 노드 객체와 1:1 대응하며, 실행 엔진이 읽는 타입드 뷰다.
 * (저장의 원본은 FlowVersion.graphJson 원시 JSON이므로, 알 수 없는 필드는 무시해도 라운드트립에 안전)
 *
 * <p>type: start | end | set | http | if | wait
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record GraphNode(
        String id,
        String name,
        String type,
        String cat,

        // --- http ---
        String method,
        String baseUrl,
        Binding baseUrlBound,
        String path,
        String bodyType,        // json | urlencoded | form | raw | xml
        String respType,        // json | text | xml | binary
        String rawBody,
        Boolean jsonRaw,
        String reqMode,         // server | client
        NodeFields fields,
        List<NodeOutput> outputs,

        // --- set ---
        List<NodeVar> vars,

        // --- if ---
        String condition,

        // --- wait ---
        String waitMsg,
        List<WaitField> waitFields,

        // --- canvas 위치(실행과 무관) ---
        Double x,
        Double y
) {
    public NodeType nodeType() {
        return NodeType.from(type);
    }

    public NodeFields fieldsOrEmpty() {
        return fields == null ? new NodeFields(List.of(), List.of(), List.of()) : fields;
    }
}
