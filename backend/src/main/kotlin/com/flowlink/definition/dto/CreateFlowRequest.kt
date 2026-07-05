package com.flowlink.definition.dto

import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.util.UUID

data class CreateFlowRequest(
    @field:NotBlank(message = "이름은 필수입니다.")
    @field:Size(max = 255)
    val name: String,

    @field:Size(max = 2000)
    val description: String?,

    val folderId: UUID?
)
