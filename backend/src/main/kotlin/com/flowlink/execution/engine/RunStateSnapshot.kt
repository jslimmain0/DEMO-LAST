package com.flowlink.execution.engine

/**
 * RunState 의 JSON 직렬화 스냅샷 — 재개 상태를 DB(execution_suspension.run_state)에 영속해
 * 서버 재시작/배포에도 wait/client/input 실행이 살아남게 한다.
 *
 * 그래프(edges/byId/order)는 저장하지 않는다 — Execution.flowVersionId 의 graphJson 재파싱으로
 * 결정적으로 재구성 가능([FlowExecutor.rehydrate]). ctx 의 값/시드는 **삽입 순서가 의미론**
 * (bare 토큰 nearest-upstream)이라 JSON 객체 순서(Jackson LinkedHashMap)로 보존한다.
 *
 * ⚠ 숫자는 JSON 라운드트립에서 타입이 좁혀질 수 있다(Long→Int 등) — SpEL 비교는 값 기준이라
 * 실사용 영향은 없으나 e2e 로 검증한다.
 */
data class RunStateSnapshot(
    val activeIds: List<String>,
    val ctxValues: Map<String, Any?>,
    val ctxSeeds: Map<String, Any?>,
    val index: Int,
    val seq: Int,
    val pendingNodeId: String?,
    val pendingForm: FlowExecutor.PendingForm?,
    val relayBase: String?,
    val relayRunId: String?,
)
