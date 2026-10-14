package com.flowlink.mock

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.workspace.WorkspaceService
import org.springframework.stereotype.Component
import java.time.Instant
import java.util.UUID

/** Bounded trial history shares execution_get without inventing a workflow or changing its foreign keys. */
@Component
class MockTrialStore(private val workspaces: WorkspaceService, private val mocks: com.flowlink.core.repository.MockServerRepository,
                     private val json: com.flowlink.common.json.JsonService) {
    private data class Trial(val tenant: String, val workspace: UUID?, val mockId: UUID, val startedAt: Instant, var result: Map<String, Any?>, var bytes: Int = 0)
    private val trials = LinkedHashMap<UUID, Trial>()
    private val maxBytes = 32 * 1024 * 1024
    private fun size(value: Map<String, Any?>) = json.toJson(value).toByteArray(Charsets.UTF_8).size
    private fun evictFinished(except: UUID): Boolean {
        val old = trials.entries.firstOrNull { it.key != except && it.value.result["status"] != "RUNNING" } ?: return false
        trials.remove(old.key)
        return true
    }

    @Synchronized fun start(id: UUID, workspace: UUID?, mockId: UUID, definitionVersion: Int, protocolFingerprint: String?) {
        if (trials.containsKey(id)) throw BadRequestException("이미 접수된 executionId입니다. 다시 전송하지 말고 execution_get으로 조회하세요.")
        while (trials.size >= 1000) {
            val finished = trials.entries.firstOrNull { it.value.result["status"] != "RUNNING" } ?: throw BadRequestException("시험 실행 이력이 가득 찼습니다.")
            trials.remove(finished.key)
        }
        val now = Instant.now()
        trials[id] = Trial(TenantContext.getTenantId(), workspace, mockId, now, mapOf("id" to id, "executionId" to id, "kind" to "MOCK_TCP_TEST", "status" to "RUNNING",
            "mockId" to mockId, "definitionVersion" to definitionVersion, "protocolFingerprint" to protocolFingerprint, "startedAt" to now,
            "retention" to "프로세스 재시작 전 최근 1000건·JSON 합계 32MB. 워크플로 DB 실행 이력과 별도입니다."))
        trials.getValue(id).let { it.bytes = size(it.result) }
        while (trials.values.sumOf { it.bytes.toLong() } > maxBytes && evictFinished(id)) { }
    }

    @Synchronized fun complete(id: UUID, result: MockDtos.TcpSendResult) {
        val trial = trials.getValue(id)
        trial.result = trial.result + mapOf("status" to if (result.transportStatus == "SUCCEEDED") "SUCCEEDED" else "FAILED", "finishedAt" to Instant.now(),
            "transactionKey" to result.transactionKey, "steps" to result.steps, "request" to result.request, "response" to result.response,
            "transportStatus" to result.transportStatus, "error" to result.error, "elapsedMs" to result.elapsedMs)
        trial.bytes = size(trial.result)
        while (trials.values.sumOf { it.bytes.toLong() } > maxBytes && evictFinished(id)) { }
        if (trials.values.sumOf { it.bytes.toLong() } > maxBytes) {
            trial.result = trial.result - "request" - "response" + mapOf("contentTruncated" to true, "warnings" to listOf("시험 이력의 JSON 32MB 제한으로 본문을 생략했습니다. 최초 전송 응답은 원문 길이를 유지합니다."),
                "request" to mapOf("wireLength" to result.request.total), "response" to mapOf("wireLength" to result.response.bytes))
            trial.bytes = size(trial.result)
        }
    }

    @Synchronized fun get(id: UUID): Map<String, Any?>? {
        val trial = trials[id]?.takeIf { it.tenant == TenantContext.getTenantId() } ?: return null
        workspaces.requireRead(workspaces.currentUsername(), trial.workspace)
        val mock = mocks.findByIdAndTenantId(trial.mockId, trial.tenant).orElseThrow { com.flowlink.common.error.NotFoundException("시험한 Mock이 삭제되어 이력을 조회할 수 없습니다.") }
        workspaces.requireRead(workspaces.currentUsername(), mock.workspaceId)
        return trial.result
    }
}
