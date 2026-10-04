package com.flowlink.core.graph

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * set 노드의 변수 한 개.
 *
 * @param secret true면 민감값 — 로그/출력에서 마스킹한다. (실제 시크릿 볼트 연동은 후속 Phase)
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class NodeVar(
    val id: String?,
    val key: String?,
    val value: String?,
    val secret: Boolean,
    val bound: Binding?
)
