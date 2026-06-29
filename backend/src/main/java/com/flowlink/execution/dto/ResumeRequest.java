package com.flowlink.execution.dto;

/**
 * 브라우저(client 모드)가 직접 호출한 결과를 서버로 돌려보내 실행을 재개하는 요청 바디.
 *
 * @param nodeId     중단을 유발한 client 노드 id(검증/표시용)
 * @param status     브라우저가 받은 HTTP 상태코드
 * @param body       응답 본문(원문 텍스트). 서버가 노드의 respType 에 따라 파싱한다.
 * @param error      네트워크/CORS 등으로 실패한 경우의 에러 메시지(성공이면 null)
 * @param durationMs 브라우저가 측정한 소요 시간(ms, 선택)
 */
public record ResumeRequest(
        String nodeId,
        Integer status,
        String body,
        String error,
        Long durationMs
) {
}
