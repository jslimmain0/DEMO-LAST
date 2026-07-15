package com.flowlink.core.repository

import com.flowlink.core.domain.ExecutionSuspension
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import java.util.UUID

interface ExecutionSuspensionRepository : JpaRepository<ExecutionSuspension, UUID> {

    /**
     * claim — 조건부 삭제의 영향 행수 1 = 재개 권한 획득(이중 재개 방지 CAS).
     * 반드시 트랜잭션 안에서 호출하고, 0 이면 이미 다른 쪽(콜백/타임아웃/resume)이 가져간 것.
     */
    @Modifying
    fun deleteByExecutionIdAndPendingNodeId(executionId: UUID, pendingNodeId: String): Int
}
