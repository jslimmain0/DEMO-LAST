package com.flowlink.folder

import com.flowlink.core.domain.Folder
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.time.Instant
import java.util.UUID

/** 폴더 관련 DTO 모음. */
object FolderDtos {

    data class FolderRequest(
        @get:JvmName("name")
        @field:NotBlank @field:Size(max = 255) val name: String
    )

    data class FolderSummary(
        val id: UUID,
        val name: String,
        val flowCount: Long,
        val createdAt: Instant
    ) {
        companion object {
            @JvmStatic
            fun from(f: Folder, flowCount: Long): FolderSummary {
                return FolderSummary(f.id, f.name, flowCount, f.createdAt)
            }
        }
    }

    /** 워크플로를 폴더로 이동(null = 미분류). */
    data class MoveFlowRequest(
        @get:JvmName("folderId")
        val folderId: UUID?
    )
}
