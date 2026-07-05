package com.flowlink.definition.dto

import com.fasterxml.jackson.databind.JsonNode
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size

/**
 * 새 버전 저장. [graph] 는 프로토타입과 동일한 형태의 그래프 객체
 * (`{name?, nodes:[...], edges:[...]}`). 저장 시 불변 새 버전으로 적재된다.
 */
data class SaveVersionRequest(
    @get:JvmName("graph")
    @field:NotNull(message = "graph 는 필수입니다.")
    val graph: JsonNode,

    @get:JvmName("note")
    @field:Size(max = 500)
    val note: String?
)
