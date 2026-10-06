package com.flowlink.definition.dto

import com.fasterxml.jackson.databind.JsonNode
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size

/**
 * 새 버전 저장. [graph] 는 프로토타입과 동일한 형태의 그래프 객체
 * (`{name?, nodes:[...], edges:[...]}`). 저장 시 불변 새 버전으로 적재된다.
 */
data class SaveVersionRequest(
    @field:NotNull(message = "graph 는 필수입니다.")
    val graph: JsonNode,

    @field:Size(max = 500)
    val note: String?,

    /** true = 📌 보존 버전(커밋) 으로 저장 — 자동 보존 정책의 버전 정리에서 영구 제외. */
    val pinned: Boolean = false,
)
