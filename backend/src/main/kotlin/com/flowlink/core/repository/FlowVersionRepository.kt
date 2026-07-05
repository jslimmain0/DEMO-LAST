package com.flowlink.core.repository

import com.flowlink.core.domain.FlowVersion
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface FlowVersionRepository : JpaRepository<FlowVersion, UUID> {

    fun findByFlowIdAndVersionNo(flowId: UUID, versionNo: Int): Optional<FlowVersion>
}
