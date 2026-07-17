package com.flowlink.execution.dto

import com.fasterxml.jackson.databind.JsonNode

/**
 * 실행 요청. [input] 은 실행 시작 시 주입할 초기 변수(선택), [env] 는 선택한 환경(dev/staging/prod)의 변수 묶음(선택),
 * [versionNo] 가 null 이면 현재 버전 실행.
 * input 의 키는 `{{ key@input }}` 또는 bare `{{ key }}`, env 의 키는 `{{ key@env }}` 로 참조 가능.
 *
 * [relayRunId]/[relayBase] 는 (구) relay.js 연동용 필드 — 하위호환 위해 남겨두되 **무시**한다.
 * wait 콜백은 이제 백엔드가 직접 받아 재개하며, 수신 URL 은 실행ID 기반으로 서버가 확정한다
 * ({baseUrl}/relay/{execId}/cb/{nodeId}, baseUrl = flowlink.execution.relay.base-url).
 */
data class RunRequest(
    val input: JsonNode?,
    val env: JsonNode?,
    val versionNo: Int?,
    val relayRunId: String?,
    val relayBase: String?
)
