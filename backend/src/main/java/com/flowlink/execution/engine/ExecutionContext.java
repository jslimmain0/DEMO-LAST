package com.flowlink.execution.engine;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 실행 중 노드 출력/요청값을 누적하는 컨텍스트. 삽입 순서를 보존(LinkedHashMap)해
 * "가장 가까운 상위 노드 우선"(bare 토큰) 규칙을 재현한다.
 *
 * <p>키 규약: 노드 출력은 {@code nodeId}, 요청값은 {@code "req:" + nodeId}.
 */
public class ExecutionContext {

    private final LinkedHashMap<String, Object> values = new LinkedHashMap<>();

    public void putOutput(String nodeId, Object value) {
        values.put(nodeId, value);
    }

    public void putRequest(String nodeId, Object value) {
        values.put("req:" + nodeId, value);
    }

    public Object raw(String key) {
        return values.get(key);
    }

    /** 삽입 역순 키 목록(가장 최근에 생성된 출력부터). */
    public List<String> keysReversed() {
        List<String> keys = new ArrayList<>(values.keySet());
        java.util.Collections.reverse(keys);
        return keys;
    }

    public Map<String, Object> snapshot() {
        return new LinkedHashMap<>(values);
    }
}
