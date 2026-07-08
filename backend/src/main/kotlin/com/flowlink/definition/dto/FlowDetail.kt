package com.flowlink.definition.dto

import com.fasterxml.jackson.databind.JsonNode
import java.time.Instant
import java.util.UUID

/** 편집기용 상세 — 현재 버전의 그래프를 포함한다. */
data class FlowDetail(
    val id: UUID,
    val name: String,
    val description: String?,
    val currentVersion: Int,
    val folderId: UUID?, // 에디터 ← 가 "그 폴더"로 돌아가기 위함
    val createdAt: Instant,
    val updatedAt: Instant,
    val graph: JsonNode
)
