package com.flowlink.execution.dto

import com.fasterxml.jackson.databind.JsonNode

/**
 * 실행 요청. [input] 은 실행 시작 시 주입할 초기 변수(선택), [versionNo] 가 null 이면 현재 버전 실행.
 * input 의 키는 `{{ key@input }}` 또는 bare `{{ key }}` 로 참조 가능.
 *
 * [relayRunId]/[relayBase] 는 wait(콜백 대기) 노드용 — 브라우저가 실행 시작 직전
 * crypto 영숫자 16자 실행ID를 만들어 relay 에 등록/SSE 연결한 뒤 함께 보낸다. 서버는 이것으로
 * 각 wait 노드의 수신 URL({relayBase}/cb/{relayRunId}/{nodeId})을 조립해 `{{ url@노드ID }}` 로 노출한다.
 */
data class RunRequest(
    val input: JsonNode?,
    val versionNo: Int?,
    val relayRunId: String?,
    val relayBase: String?
)
