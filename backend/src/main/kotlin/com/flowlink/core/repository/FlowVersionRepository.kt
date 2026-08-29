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

    /**
     * 버전 스냅샷 보존 정리 — flow 마다 최신 :keep 개만 남기고 오래된 버전 삭제.
     * 단 **실행 이력이 참조하는 버전**(재실행/rehydrate 재현용)과 **트리거가 고정한 버전**은 남긴다.
     * (자동 저장이 1.5초마다 그래프 CLOB 버전을 쌓아 DB 가 무한 성장하던 부하 지점의 해소)
     */
    @org.springframework.data.jpa.repository.Modifying
    @org.springframework.data.jpa.repository.Query(
        "DELETE FROM FlowVersion v WHERE " +
            "v.versionNo <= (SELECT f.currentVersion FROM Flow f WHERE f.id = v.flowId) - :keep " +
            "AND (v.pinned IS NULL OR v.pinned = false) " + // 📌 보존 버전(커밋)은 영구 유지
            "AND NOT EXISTS (SELECT 1 FROM Execution e WHERE e.flowVersionId = v.id) " +
            "AND NOT EXISTS (SELECT 1 FROM FlowTrigger t WHERE t.flowId = v.flowId AND t.versionNo = v.versionNo)"
    )
    fun pruneOldVersions(@org.springframework.data.repository.query.Param("keep") keep: Int): Int
}
