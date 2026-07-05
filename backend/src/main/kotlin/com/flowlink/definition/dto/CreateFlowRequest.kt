package com.flowlink.definition.dto

import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.util.UUID

data class CreateFlowRequest(
    @get:JvmName("name")
    @field:NotBlank(message = "이름은 필수입니다.")
    @field:Size(max = 255)
    val name: String,

    @get:JvmName("description")
    @field:Size(max = 2000)
    val description: String?,

    @get:JvmName("folderId")
    val folderId: UUID?
)
