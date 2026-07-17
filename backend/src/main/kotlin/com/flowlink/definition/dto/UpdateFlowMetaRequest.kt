package com.flowlink.definition.dto

import jakarta.validation.constraints.Size

/** 워크플로 이름·설명만 수정(버전 그래프 불변). null 필드는 미변경. */
data class UpdateFlowMetaRequest(
    @field:Size(max = 255)
    val name: String? = null,

    @field:Size(max = 2000)
    val description: String? = null
)
