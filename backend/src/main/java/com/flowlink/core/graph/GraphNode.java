package com.flowlink.core.graph;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;
import java.util.Map;

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
        String respType,        // json | xml | urlencoded | form | text | binary
        String rawBody,
        Boolean jsonRaw,
        String reqMode,         // server | client
        String charset,         // 요청 인코딩·응답 디코딩 문자셋(UTF-8 기본 · EUC-KR/MS949/US-ASCII). server 모드에 적용
        NodeFields fields,
        List<NodeOutput> outputs,

        // --- set ---
        List<NodeVar> vars,

        // --- if ---
        String condition,

        // --- wait ---
        String waitMsg,
        List<WaitField> waitFields,

        // --- transform ---
        String transformId,
        Map<String, String> config,

        // --- tcp (고정길이 금융 전문) ---
        String tcpHost,
        Integer tcpPort,
        String tcpEncoding,
        Integer tcpTimeoutMs,
        Integer tcpPrefixLength,
        Boolean tcpPrefixIncludesSelf,
        List<TcpField> tcpRequest,
        List<TcpRespField> tcpResponse,

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
