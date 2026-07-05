package com.flowlink.definition.dto

import com.flowlink.core.domain.Flow
import java.time.Instant
import java.util.UUID

/** 대시보드 목록용 요약. */
data class FlowSummary(
    val id: UUID,
    val name: String,
    val description: String?,
    val currentVersion: Int,
    val folderId: UUID?,
    val updatedAt: Instant
) {
    companion object {
        @JvmStatic
        fun from(f: Flow): FlowSummary =
            FlowSummary(
                f.id, f.name, f.description,
                f.currentVersion, f.folderId, f.updatedAt
            )
    }
}
