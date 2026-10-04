package com.flowlink.execution.dto

/**
 * input(사용자 입력) 노드에서 실행이 중단됐을 때, 브라우저가 모달(input box)로 띄울 입력 명세.
 * 사용자가 confirm 하면 [ResumeRequest.formValues] 로 값이 돌아와 노드 출력이 된다.
 * [InputField.type] 은 값 파싱 힌트(string 기본 · number · boolean · json) — 브라우저가 파싱해 보낸다.
 */
data class PendingInputRequest(
    val nodeId: String?,
    val nodeName: String?,
    val message: String?,
    val fields: List<InputField>
) {
    data class InputField(val key: String?, val label: String?, val type: String?)
}
