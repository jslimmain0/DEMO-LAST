package com.flowlink.folder

import com.flowlink.core.domain.Folder
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.time.Instant
import java.util.UUID

/**
 * 폴더 관련 DTO 모음.
 * 요청 DTO 에 @get:JvmName 금지 — jackson-module-kotlin 이 생성자(Creator)를 못 찾아
 * 역직렬화가 통째로 깨진다(코틀린 이관 회귀: 폴더 생성/이름변경/이동이 전부 500 이었음).
 */
object FolderDtos {

    /** 생성/이름변경 공용 — parentId 는 생성 시 상위 폴더 지정(중첩), 이름변경에선 무시. */
    data class FolderRequest(
        @field:NotBlank @field:Size(max = 255) val name: String,
        val parentId: UUID? = null
    )

    data class FolderSummary(
        val id: UUID,
        val name: String,
        val parentId: UUID?,
        val flowCount: Long,
        val createdAt: Instant
    ) {
        companion object {
            @JvmStatic
            fun from(f: Folder, flowCount: Long): FolderSummary {
                return FolderSummary(f.id, f.name, f.parentId, flowCount, f.createdAt)
            }
        }
    }

    /** 워크플로를 폴더로 이동(null = 미분류). */
    data class MoveFlowRequest(
        val folderId: UUID?
    )

    /** 폴더 재배치 — 새 상위 폴더(null = 루트). */
    data class MoveFolderRequest(
        val parentId: UUID?
    )
}
