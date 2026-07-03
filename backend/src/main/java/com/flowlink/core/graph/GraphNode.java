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
        Boolean paramsRaw,      // 쿼리 파라미터 [필드↔Raw] — true 면 rawParams(a=1&b=2) 사용
        String rawParams,
        Boolean headersRaw,     // 헤더 [필드↔Raw] — true 면 rawHeaders(Key: Value 줄바꿈) 사용
        String rawHeaders,
        String reqMode,         // server | client
        String charset,         // 요청 인코딩·응답 디코딩 문자셋(UTF-8 기본 · EUC-KR/MS949/US-ASCII). server 모드에 적용
        NodeFields fields,
        List<NodeOutput> outputs,

        // --- set ---
        List<NodeVar> vars,

        // --- if ---
        String condition,

        // --- input(사용자 입력 대기) ---
        String waitMsg,
        List<WaitField> waitFields,
        // --- form(폼 전송 팝업) ---
        String formAction,      // 팝업으로 열어 폼을 target 전송할 URL
        String formMethod,      // POST | GET
        // --- wait(콜백 대기) ---
        Integer waitTimeoutSec, // 콜백 타임아웃(초, 기본 120)
        String cbRespType,      // 콜백에 줄 응답 형식: text | html | json
        String cbRespBody,      // 콜백에 줄 응답 본문(실행 시작 시점 토큰 치환)

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

    /**
     * 실행 시 적용할 실질 타입 — 레거시 그래프 호환 시프트 포함.
     * 과거에는 type="wait" 하나가 폼 전송(formAction)·입력 대기(waitFields)를 겸했으므로,
     * wait 인데 formAction 이 있으면 FORM, waitFields 만 있으면(신규 wait 설정 없이) INPUT 으로 본다.
     */
    public NodeType effectiveType() {
        NodeType t = nodeType();
        if (t != NodeType.WAIT) {
            return t;
        }
        if (formAction != null && !formAction.isBlank()) {
            return NodeType.FORM;
        }
        boolean hasNewWaitConfig = waitTimeoutSec != null || cbRespType != null || cbRespBody != null;
        if (!hasNewWaitConfig && waitFields != null && !waitFields.isEmpty()) {
            return NodeType.INPUT;
        }
        return NodeType.WAIT;
    }

    public NodeFields fieldsOrEmpty() {
        return fields == null ? new NodeFields(List.of(), List.of(), List.of()) : fields;
    }
}
