package com.flowlink.execution.dto

import com.fasterxml.jackson.databind.JsonNode

/**
 * 실행 요청. [input] 은 실행 시작 시 주입할 초기 변수(선택), [env] 는 선택한 환경(dev/staging/prod)의 변수 묶음(선택),
 * [versionNo] 가 null 이면 현재 버전 실행.
 * input 의 키는 `{{ key@input }}` 또는 bare `{{ key }}`, env 의 키는 `{{ key@env }}` 로 참조 가능.
 *
 * wait 콜백은 백엔드가 직접 받아 재개하며, 수신 URL 은 실행ID 기반으로 서버가 확정한다(RelayController).
 * (구 relay.js 연동용 relayRunId/relayBase 필드는 제거됨 — 프론트가 더 이상 보내지 않고, Jackson 은 미지 필드를 무시).
 */
data class RunRequest(
    val input: JsonNode?,
    val env: JsonNode?,        // {{ key@env }} 변수 묶음
    val envName: String?,      // 활성 환경 이름 — 시크릿 환경 스코프 선택(null/blank=공통만)
    val versionNo: Int?,
)
