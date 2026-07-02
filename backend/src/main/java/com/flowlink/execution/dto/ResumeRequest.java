package com.flowlink.execution.dto;

import java.util.Map;

/**
 * 중단된 실행을 재개하는 요청 바디. client HTTP 는 status/body/error 를, WAIT(폼)은 formValues 를 채운다.
 *
 * @param nodeId     중단을 유발한 노드 id(검증/표시용)
 * @param status     (client HTTP) 브라우저가 받은 HTTP 상태코드
 * @param body       (client HTTP) 응답 본문(원문). 서버가 respType 에 따라 파싱
 * @param error      (client HTTP) 네트워크/CORS 실패 메시지(성공이면 null)
 * @param formValues (WAIT 폼) 사용자가 제출한 키-값 → 노드 출력이 됨
 * @param durationMs 소요 시간(ms, 선택)
 */
public record ResumeRequest(
        String nodeId,
        Integer status,
        String body,
        String error,
        Map<String, Object> formValues,
        Long durationMs
) {
}
