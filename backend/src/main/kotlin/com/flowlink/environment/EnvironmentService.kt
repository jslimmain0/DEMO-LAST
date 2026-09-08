package com.flowlink.environment

import com.fasterxml.jackson.core.type.TypeReference
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Environment
import com.flowlink.core.repository.EnvironmentRepository
import com.flowlink.core.repository.FlowRepository
import com.flowlink.settings.SettingsService
import com.flowlink.workspace.WorkspaceService
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.LinkedHashMap
import java.util.UUID

/**
 * 실행 환경(dev/staging/prod)+변수 — 테넌트 스코프 DB 저장(팀 공유). 쓰기는 시크릿과 같은 **승인 사용자** 게이트.
 * 실행 입력값(플로우별 `{{키@input}}`)은 AppSetting `runinput:{flowId}` 키로 저장(플로우 읽기/쓰기 권한 = 워크스페이스 롤).
 */
@Service
class EnvironmentService(
    private val repo: EnvironmentRepository,
    private val flows: FlowRepository,
    private val settings: SettingsService,
    private val workspace: WorkspaceService,
    private val json: JsonService,
) {

    data class EnvView(val name: String, val vars: Map<String, String>, val updatedAt: java.time.Instant?)

    private val mapType = object : TypeReference<LinkedHashMap<String, String>>() {}

    private fun tenant(): String = TenantContext.getTenantId()

    private fun requireApproved() {
        if (!workspace.isApproved(workspace.currentUsername())) {
            throw ForbiddenException("환경 변경은 가입 승인 후 가능합니다.")
        }
    }

    private fun normName(name: String?): String {
        val n = name?.trim().orEmpty()
        if (n.isEmpty()) throw BadRequestException("환경 이름이 비었습니다.")
        if (n.length > 120) throw BadRequestException("환경 이름은 120자 이하여야 합니다.")
        return n
    }

    private fun parseVars(raw: String?): Map<String, String> =
        try { json.mapper().readValue(raw ?: "{}", mapType) } catch (e: Exception) { emptyMap() }

    private fun cleanVars(vars: Map<String, String>?): LinkedHashMap<String, String> {
        val out = LinkedHashMap<String, String>()
        for ((k, v) in vars ?: emptyMap()) {
            val key = k.trim()
            if (key.isEmpty()) continue
            out[key] = v
        }
        return out
    }

    private fun view(e: Environment) = EnvView(e.name, parseVars(e.varsJson), e.updatedAt ?: e.createdAt)

    @Transactional(readOnly = true)
    fun list(): List<EnvView> = repo.findByTenantIdOrderByNameAsc(tenant()).map { view(it) }

    /** 생성 또는 갱신(변수 통째 교체). */
    @Transactional
    fun put(name: String?, vars: Map<String, String>?): EnvView {
        requireApproved()
        val n = normName(name)
        val t = tenant()
        val varsJson = json.toJson(cleanVars(vars))
        val existing = repo.findByTenantIdAndName(t, n).orElse(null)
        val saved = if (existing == null) repo.saveAndFlush(Environment.create(t, n, varsJson)) else { existing.varsJson = varsJson; existing }
        return view(saved)
    }

    /** 이름 변경(변수 유지). 대상 이름이 이미 있으면 400. */
    @Transactional
    fun rename(name: String, to: String?): EnvView {
        requireApproved()
        val from = normName(name)
        val target = normName(to)
        val t = tenant()
        val e = repo.findByTenantIdAndName(t, from).orElseThrow { BadRequestException("환경이 없습니다: $from") }
        if (from == target) return view(e)
        if (repo.findByTenantIdAndName(t, target).isPresent) throw BadRequestException("같은 이름의 환경이 이미 있습니다: $target")
        val created = repo.saveAndFlush(Environment.create(t, target, e.varsJson))
        repo.delete(e)
        return view(created)
    }

    @Transactional
    fun delete(name: String) {
        requireApproved()
        repo.findByTenantIdAndName(tenant(), normName(name)).ifPresent { repo.delete(it) }
    }

    // ---------- 실행 입력값(플로우별) ----------

    private fun runInputKey(flowId: UUID) = "runinput:$flowId"

    private fun flowWorkspace(flowId: UUID, write: Boolean): UUID? {
        val flow = flows.findByIdAndTenantId(flowId, tenant()).orElseThrow { BadRequestException("워크플로가 없습니다: $flowId") }
        val me = workspace.currentUsername()
        if (write) workspace.requireWrite(me, flow.workspaceId) else workspace.requireRead(me, flow.workspaceId)
        return flow.workspaceId
    }

    @Transactional(readOnly = true)
    fun runInput(flowId: UUID): Map<String, String> {
        flowWorkspace(flowId, write = false)
        return parseVars(settings.get(runInputKey(flowId)))
    }

    @Transactional
    fun putRunInput(flowId: UUID, vars: Map<String, String>?): Map<String, String> {
        flowWorkspace(flowId, write = true)
        val cleaned = cleanVars(vars)
        settings.put(runInputKey(flowId), if (cleaned.isEmpty()) null else json.toJson(cleaned)) // 빈 값 = 삭제
        return cleaned
    }
}
