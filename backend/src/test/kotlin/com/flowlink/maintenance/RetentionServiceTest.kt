package com.flowlink.maintenance

import com.flowlink.core.domain.Execution
import com.flowlink.core.domain.ExecutionStatus
import com.flowlink.core.domain.Flow
import com.flowlink.core.domain.FlowVersion
import com.flowlink.core.domain.TriggerType
import com.flowlink.core.repository.ExecutionRepository
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FlowVersionRepository
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.TestPropertySource
import java.util.UUID

/**
 * 자동 보존 정책 — 실행 이력(N일 이전 삭제, 진행 중 보호) + 버전 스냅샷(flow 당 keep 개, 참조 버전 보호).
 * (스키마: H2 인메모리 + create-drop, Flyway off — 코드베이스 관례. 보존 파라미터는 테스트 값으로 고정)
 */
@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:retention;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.flyway.enabled=false",
    "spring.jpa.hibernate.ddl-auto=create-drop",
    "flowlink.retention.execution-days=30",
    "flowlink.retention.flow-versions-keep=2",
])
class RetentionServiceTest {

    @Autowired lateinit var retention: RetentionService
    @Autowired lateinit var flowRepo: FlowRepository
    @Autowired lateinit var versionRepo: FlowVersionRepository
    @Autowired lateinit var executionRepo: ExecutionRepository
    @Autowired lateinit var jdbc: JdbcTemplate

    private fun newFlow(name: String, versions: Int): Flow {
        val f = Flow.create("default", name, null)
        f.currentVersion = versions
        val saved = flowRepo.saveAndFlush(f)
        for (v in 1..versions) {
            versionRepo.save(FlowVersion.create(saved.id, v, name, """{"nodes":[],"edges":[]}""", null, null))
        }
        versionRepo.flush()
        return saved
    }

    private fun newExecution(flowId: UUID, versionId: UUID, status: ExecutionStatus, daysAgo: Long): UUID {
        val e = Execution.start("default", flowId, versionId, TriggerType.MANUAL, null, null)
        val saved = executionRepo.saveAndFlush(e)
        // startedAt 은 팩토리가 now 로 고정 — 보존 판정 검증 위해 SQL 로 백데이트
        jdbc.update("UPDATE execution SET started_at = DATEADD('DAY', ?, CURRENT_TIMESTAMP), status = ? WHERE id = ?",
            -daysAgo, status.name, saved.id)
        return saved.id
    }

    @Test
    fun `실행 이력 보존 - 30일 이전의 끝난 실행만 삭제, 진행 중은 보호`() {
        val flow = newFlow("보존 플로우", 1)
        val vId = versionRepo.findByFlowIdAndVersionNo(flow.id, 1).get().id
        val oldDone = newExecution(flow.id, vId, ExecutionStatus.SUCCEEDED, 60)
        val oldWaiting = newExecution(flow.id, vId, ExecutionStatus.WAITING, 60)
        val recent = newExecution(flow.id, vId, ExecutionStatus.FAILED, 5)

        retention.sweepExecutions()

        assertFalse(executionRepo.findById(oldDone).isPresent, "60일 지난 SUCCEEDED 는 삭제")
        assertTrue(executionRepo.findById(oldWaiting).isPresent, "WAITING 은 오래돼도 보호")
        assertTrue(executionRepo.findById(recent).isPresent, "30일 이내는 유지")
    }

    @Test
    fun `버전 보존 - flow 당 최신 2개 유지, 실행이 참조하는 옛 버전과 📌 보존 버전은 보호`() {
        val flow = newFlow("버전 플로우", 5) // v1~v5, keep=2 → v1~v3 이 정리 대상
        val v1 = versionRepo.findByFlowIdAndVersionNo(flow.id, 1).get()
        newExecution(flow.id, v1.id, ExecutionStatus.SUCCEEDED, 1) // v1 을 실행이 참조
        val v2 = versionRepo.findByFlowIdAndVersionNo(flow.id, 2).get()
        v2.pinned = true // 📌 보존 버전(커밋) — 사용자가 명시적으로 남긴 스냅샷
        versionRepo.saveAndFlush(v2)

        retention.sweepFlowVersions()

        assertTrue(versionRepo.findByFlowIdAndVersionNo(flow.id, 1).isPresent, "실행이 참조하는 v1 은 보호")
        assertTrue(versionRepo.findByFlowIdAndVersionNo(flow.id, 2).isPresent, "📌 보존 v2 는 영구 보호")
        assertFalse(versionRepo.findByFlowIdAndVersionNo(flow.id, 3).isPresent, "v3 삭제")
        assertTrue(versionRepo.findByFlowIdAndVersionNo(flow.id, 4).isPresent, "최신 2개(v4) 유지")
        assertTrue(versionRepo.findByFlowIdAndVersionNo(flow.id, 5).isPresent, "최신 2개(v5) 유지")
        assertEquals(5, flowRepo.findById(flow.id).get().currentVersion)
    }
}
