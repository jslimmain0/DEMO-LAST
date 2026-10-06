package com.flowlink.core.graph

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/** 노드가 내보낸다고 선언한 출력 키와 타입(에디터 자동완성/검증용 메타데이터). */
@JsonIgnoreProperties(ignoreUnknown = true)
data class NodeOutput(
    val key: String?,
    val type: String?
)
