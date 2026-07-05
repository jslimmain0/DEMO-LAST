package com.flowlink.core.repository

import com.flowlink.core.domain.NodeExecution
import org.springframework.data.jpa.repository.JpaRepository
import java.util.UUID

interface NodeExecutionRepository : JpaRepository<NodeExecution, UUID> {

    fun findByExecutionIdOrderBySeqAsc(executionId: UUID): List<NodeExecution>
}
