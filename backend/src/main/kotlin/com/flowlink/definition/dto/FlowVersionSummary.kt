package com.flowlink.definition.dto

import com.flowlink.core.domain.FlowVersion
import java.time.Instant
import java.util.UUID

data class FlowVersionSummary(
    val id: UUID,
    val versionNo: Int,
    val name: String,
    val note: String?,
    val createdBy: String?,
    val createdAt: Instant
) {
    companion object {
        @JvmStatic
        fun from(v: FlowVersion): FlowVersionSummary =
            FlowVersionSummary(
                v.id, v.versionNo, v.name,
                v.note, v.createdBy, v.createdAt
            )
    }
}
