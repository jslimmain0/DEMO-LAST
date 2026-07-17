package com.flowlink.definition.dto

import com.flowlink.core.domain.Flow
import java.time.Instant
import java.util.UUID

/**
 * 대시보드 목록용 요약. nodeCount/nodeTypes 로 카드 미리보기를 목록 한 번에 그려(카드별 graph 재조회 N+1 제거),
 * nodeText 로 노드 내용(이름/URL/조건 등) 가로지르기 검색.
 */
data class FlowSummary(
    val id: UUID,
    val name: String,
    val description: String?,
    val currentVersion: Int,
    val folderId: UUID?,
    val updatedAt: Instant,
    val nodeCount: Int = 0,
    val nodeTypes: List<String> = emptyList(),
    val nodeText: String? = null
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
