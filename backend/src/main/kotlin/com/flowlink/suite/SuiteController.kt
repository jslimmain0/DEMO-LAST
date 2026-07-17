package com.flowlink.suite

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.repository.FlowRepository
import com.flowlink.execution.ExecutionService
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/**
 * 테스트 스위트 일괄 실행 — 폴더(직속) 또는 지정 워크플로들을 한 번에 비동기 실행하고 실행 id 목록을 반환한다.
 * 프론트가 각 executionId 를 폴링해 성공/실패 매트릭스를 만든다(개별 실행·이력은 기존 경로 재사용).
 */
@RestController
@RequestMapping("/api/v1/suites")
class SuiteController(
    private val flowRepo: FlowRepository,
    private val executionService: ExecutionService,
) {

    data class SuiteRunRequest(val flowIds: List<UUID>? = null, val folderId: UUID? = null)
    data class SuiteRunItem(val flowId: UUID, val flowName: String, val executionId: UUID?, val status: String, val error: String?)

    @PostMapping("/run")
    fun run(@RequestBody req: SuiteRunRequest): List<SuiteRunItem> {
        val tenant = TenantContext.getTenantId()
        val flows = when {
            !req.flowIds.isNullOrEmpty() -> req.flowIds.mapNotNull { flowRepo.findByIdAndTenantId(it, tenant).orElse(null) }
            req.folderId != null -> flowRepo.findByTenantIdAndFolderIdAndArchivedFalse(tenant, req.folderId)
            else -> throw BadRequestException("flowIds 또는 folderId 가 필요합니다.")
        }
        return flows.map { flow ->
            try {
                val d = executionService.run(flow.id, null)
                SuiteRunItem(flow.id, flow.name, d.id, d.status.name, null)
            } catch (e: Exception) {
                SuiteRunItem(flow.id, flow.name, null, "REJECTED", e.message)
            }
        }
    }
}
