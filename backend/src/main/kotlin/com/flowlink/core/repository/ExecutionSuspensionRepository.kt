package com.flowlink.core.repository

import com.flowlink.core.domain.ExecutionSuspension
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.util.UUID

interface ExecutionSuspensionRepository : JpaRepository<ExecutionSuspension, UUID> {

    /**
     * claim — 조건부 벌크 DELETE 의 영향 행수 1 = 재개 권한 획득(이중 재개 방지 CAS).
     * ⚠ 반드시 `@Query` 단일 DELETE 여야 원자적이다 — 파생 deleteBy… 는 SELECT 후 PK 로 개별 remove 라
     * (execution_id 가 PK) pending_node_id 조건이 flush DELETE 에서 빠져, 경합 시 다음 대기 노드 행을
     * 잘못 지우고 두 경쟁자가 모두 "1행 삭제"로 승리하는 레이스가 생긴다. 반드시 트랜잭션 안에서 호출하고,
     * 0 이면 이미 다른 쪽(콜백/타임아웃/resume)이 가져간 것.
     */
    @Modifying
    @Query("delete from ExecutionSuspension s where s.executionId = :executionId and s.pendingNodeId = :pendingNodeId")
    fun deleteByExecutionIdAndPendingNodeId(
        @Param("executionId") executionId: UUID,
        @Param("pendingNodeId") pendingNodeId: String,
    ): Int

    /** 종료(완료/실패/취소) 시 잔여 행 정리 — 없으면 0 (조용히). */
    @Modifying
    @Query("delete from ExecutionSuspension s where s.executionId = :executionId")
    fun deleteByExecutionId(@Param("executionId") executionId: UUID): Int
}
