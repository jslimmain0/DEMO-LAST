package com.flowlink.execution.engine

/**
 * 한 노드 실행 결과.
 *
 * @param value       ctx 에 적재될 출력(다운스트림 바인딩용, 마스킹 안 함)
 * @param storedValue 영속화/로그용 출력(시크릿 마스킹 적용)
 * @param reqValues   이 노드의 요청값(req: 스코프로 적재). 없으면 null.
 * @param branch      IF 노드가 선택한 분기("true"/"false"). 그 외 null.
 */
data class NodeResult(
    val ok: Boolean,
    val httpStatus: Int?,
    val requestText: String?,
    val responseText: String?,
    val value: Any?,
    val storedValue: Any?,
    val reqValues: Map<String, Any?>?,
    val branch: String?
) {
    fun withBranch(branch: String?): NodeResult =
        NodeResult(ok, httpStatus, requestText, responseText, value, storedValue, reqValues, branch)

    companion object {
        @JvmStatic
        fun ok(code: Int?, req: String?, res: String?, value: Any?): NodeResult =
            NodeResult(true, code, req, res, value, value, null, null)

        @JvmStatic
        fun okHttp(code: Int?, req: String?, res: String?, value: Any?, reqValues: Map<String, Any?>?): NodeResult =
            NodeResult(code != null && code >= 200 && code < 300, code, req, res, value, value, reqValues, null)

        @JvmStatic
        fun fail(code: Int?, req: String?, res: String?): NodeResult =
            NodeResult(false, code, req, res, null, null, null, null)
    }
}
