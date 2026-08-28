package com.flowlink.execution.dto

/**
 * 단일 노드 독립 실행 결과 — 실행 이력(Execution)으로 저장하지 않고 즉석 테스트 결과만 돌려준다.
 * 상류 바인딩은 값이 없어 null 로 풀리므로, 리터럴/노드 자체 로직 확인용이다.
 */
data class SingleNodeRunResult(
    val ok: Boolean,
    val httpStatus: Int?,
    val output: Any?,          // 노드 출력(맵/스칼라) — 다음 노드가 바인딩할 값
    val requestText: String?,  // 조립된 요청(HTTP/TCP)
    val responseText: String?, // 응답 본문 또는 실패 사유
    val durationMs: Long? = null, // 벽시계 소요시간 — 워크벤치 응답 배지용
)
