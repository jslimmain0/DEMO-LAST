package com.flowlink.execution.dto

/**
 * 폼 전송 노드에서 실행이 중단됐을 때, 브라우저가 새 창(팝업)으로 [action] 에 [method] 전송할
 * 폼 명세(필드 값은 서버에서 해석 완료). 팝업이 postMessage 로 결과를 보내거나 닫히면 실행이 재개된다.
 */
data class PendingFormRequest(
    val nodeId: String?,
    val nodeName: String?,
    val action: String,
    val method: String,
    val fields: List<FormField>
) {
    data class FormField(val key: String?, val value: String?)
}
