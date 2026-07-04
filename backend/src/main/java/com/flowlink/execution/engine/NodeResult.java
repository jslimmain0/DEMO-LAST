package com.flowlink.execution.engine;

import java.util.Map;

/**
 * 한 노드 실행 결과.
 *
 * @param value       ctx 에 적재될 출력(다운스트림 바인딩용, 마스킹 안 함)
 * @param storedValue 영속화/로그용 출력(시크릿 마스킹 적용)
 * @param reqValues   이 노드의 요청값(req: 스코프로 적재). 없으면 null.
 * @param branch      IF 노드가 선택한 분기("true"/"false"). 그 외 null.
 */
public record NodeResult(
        boolean ok,
        Integer httpStatus,
        String requestText,
        String responseText,
        Object value,
        Object storedValue,
        Map<String, Object> reqValues,
        String branch
) {
    public static NodeResult ok(Integer code, String req, String res, Object value) {
        return new NodeResult(true, code, req, res, value, value, null, null);
    }

    public static NodeResult okHttp(Integer code, String req, String res, Object value,
                                    Map<String, Object> reqValues) {
        return new NodeResult(code != null && code >= 200 && code < 300, code, req, res, value, value, reqValues, null);
    }

    public static NodeResult fail(Integer code, String req, String res) {
        return new NodeResult(false, code, req, res, null, null, null, null);
    }

    public NodeResult withBranch(String branch) {
        return new NodeResult(ok, httpStatus, requestText, responseText, value, storedValue, reqValues, branch);
    }
}
