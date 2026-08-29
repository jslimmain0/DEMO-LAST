package com.flowlink.core.repository

import com.flowlink.core.domain.FlowVersion
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface FlowVersionRepository : JpaRepository<FlowVersion, UUID> {

    fun findByFlowIdAndVersionNo(flowId: UUID, versionNo: Int): Optional<FlowVersion>

    /** 버전 기록(최신 우선) — 버전 히스토리/복원 UI 목록용. */
    fun findByFlowIdOrderByVersionNoDesc(flowId: UUID): List<FlowVersion>

    /**
     * 목록의 **현재 버전 그래프 일괄 조회** — flow 별 findByFlowIdAndVersionNo N 회(N+1)를 1 쿼리로.
     * 100개 목록 기준 로컬 H2 도 2배쯤 빨라지고, 원격 Oracle 은 왕복 N 회가 사라져 효과가 크다.
     */
    @org.springframework.data.jpa.repository.Query(
        "SELECT v FROM FlowVersion v, Flow f WHERE f.id = v.flowId AND v.versionNo = f.currentVersion AND f.id IN :flowIds"
    )
    fun findCurrentByFlowIds(@org.springframework.data.repository.query.Param("flowIds") flowIds: Collection<UUID>): List<FlowVersion>
}
