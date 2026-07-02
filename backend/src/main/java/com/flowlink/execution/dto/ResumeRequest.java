package com.flowlink.execution.dto;

import java.util.Map;

/**
 * 중단된 실행을 재개하는 요청 바디. client HTTP 는 status/body/error 를,
 * form(팝업)은 popupOpened(성공) 또는 error(팝업 차단)를, wait(콜백 대기)는 callback(수신) 또는
 * error(타임아웃/중단)를 채운다.
 *
 * @param nodeId      중단을 유발한 노드 id(검증/표시용)
 * @param status      (client HTTP) 브라우저가 받은 HTTP 상태코드
 * @param body        (client HTTP) 응답 본문(원문). 서버가 respType 에 따라 파싱
 * @param error       실패 사유 — client HTTP 네트워크 실패 / form 팝업 차단 / wait 타임아웃·중단
 * @param formValues  (legacy) 구 폼 모달 제출 값 — 하위호환 수신만
 * @param popupOpened (form) 브라우저가 팝업을 열고 form 을 submit 했는가
 * @param callback    (wait) relay 가 전달한 수신 콜백 전문
 * @param aborted     (wait) 사용자가 실행을 중단(⏹)했는가 — 실행을 CANCELLED 로 마감
 * @param durationMs  소요 시간(ms, 선택)
 */
public record ResumeRequest(
        String nodeId,
        Integer status,
        String body,
        String error,
        Map<String, Object> formValues,
        Boolean popupOpened,
        CallbackPayload callback,
        Boolean aborted,
        Long durationMs
) {
    /** relay 가 수신해 SSE 로 전달한 콜백 전문(method·URL·헤더·본문). */
    public record CallbackPayload(
            String method,
            String url,
            Map<String, String> headers,
            String body
    ) {
    }
}
