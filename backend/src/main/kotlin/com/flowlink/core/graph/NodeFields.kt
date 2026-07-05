package com.flowlink.core.graph

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/** HTTP 노드의 입력 묶음(쿼리/헤더/바디). null 리스트는 빈 리스트로 취급한다. */
@JsonIgnoreProperties(ignoreUnknown = true)
data class NodeFields(
    val params: List<NodeField>?,
    val headers: List<NodeField>?,
    val body: List<NodeField>?
) {
    fun paramsOrEmpty(): List<NodeField> = params ?: emptyList()

    fun headersOrEmpty(): List<NodeField> = headers ?: emptyList()

    fun bodyOrEmpty(): List<NodeField> = body ?: emptyList()
}
