package com.flowlink.execution.engine

/**
 * 실행 중 노드 출력/요청값을 누적하는 컨텍스트. 삽입 순서를 보존(LinkedHashMap)해
 * "가장 가까운 상위 노드 우선"(bare 토큰) 규칙을 재현한다.
 *
 * <p>키 규약: 노드 출력은 {@code nodeId}, 요청값은 {@code "req:" + nodeId}.
 */
class ExecutionContext {

    private val values = LinkedHashMap<String, Any?>()
    /**
     * 선(先)시드 값 — wait 노드의 수신 URL 처럼 실행 전에 미리 확정되는 출력.
     * 명시 스코프({@code {{ url@노드ID }}}, 바인딩)로만 보이고, bare 토큰의
     * nearest-upstream 스캔({@link #keysReversed()})에는 잡히지 않게 본 저장소와 분리한다
     * — 시드가 input/상류 출력의 같은 키를 가리는 오염 방지.
     */
    private val seeds = LinkedHashMap<String, Any?>()

    fun putOutput(nodeId: String, value: Any?) {
        values[nodeId] = value
    }

    /** 실행 전 확정 출력 시드 — 노드가 실제 실행되어 putOutput 하면 그 값이 우선한다. */
    fun putSeed(nodeId: String, value: Any?) {
        seeds[nodeId] = value
    }

    fun putRequest(nodeId: String, value: Any?) {
        values["req:$nodeId"] = value
    }

    fun raw(key: String): Any? {
        val v = values[key]
        return v ?: seeds[key]
    }

    /** 삽입 역순 키 목록(가장 최근에 생성된 출력부터). */
    fun keysReversed(): List<String> = values.keys.reversed()
}
