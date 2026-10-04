package com.flowlink.core.graph

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * 데이터 바인딩 — 상위 노드의 출력(또는 요청값)을 현재 필드에 연결한다.
 * 프로토타입의 {@code bound:{nodeName,cat,key,sourceId,scope}} 와 1:1 대응.
 *
 * @param sourceId 값을 제공하는 노드 id
 * @param key      그 노드 출력에서 꺼낼 키
 * @param scope    "req"이면 응답이 아닌 요청값에서 꺼냄(req: 스코프). null이면 응답.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class Binding(
    val nodeName: String?,
    val cat: String?,
    val key: String?,
    val sourceId: String?,
    val scope: String?
) {
    fun isRequestScope(): Boolean = "req" == scope
}
