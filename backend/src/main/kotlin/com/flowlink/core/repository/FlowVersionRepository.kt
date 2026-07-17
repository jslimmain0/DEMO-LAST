package com.flowlink.core.repository

import com.flowlink.core.domain.FlowVersion
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface FlowVersionRepository : JpaRepository<FlowVersion, UUID> {

    fun findByFlowIdAndVersionNo(flowId: UUID, versionNo: Int): Optional<FlowVersion>

    /** 버전 기록(최신 우선) — 버전 히스토리/복원 UI 목록용. */
    fun findByFlowIdOrderByVersionNoDesc(flowId: UUID): List<FlowVersion>
}
