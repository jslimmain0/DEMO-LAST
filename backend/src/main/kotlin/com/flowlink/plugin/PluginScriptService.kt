package com.flowlink.plugin

import com.flowlink.codec.CodecCtx
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.PluginScript
import com.flowlink.core.repository.PluginScriptRepository
import com.flowlink.plugin.script.CompiledScript
import com.flowlink.plugin.script.ScriptMeta
import com.flowlink.plugin.script.ScriptRuntime
import com.flowlink.plugin.script.toPlugin
import com.flowlink.transform.ScriptPluginLoader
import com.flowlink.transform.TransformRegistry
import com.flowlink.workspace.WorkspaceService
import org.slf4j.LoggerFactory
import org.springframework.context.annotation.Lazy
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.Base64
import java.util.UUID

/**
 * 스크립트 플러그인 — CRUD·시험 실행·승인 흐름. 게이트: 읽기=누구나(로그인/게스트), 쓰기·try=승인 사용자, 승인/반려=관리자.
 * 승인본(liveSource)만 레지스트리에 올라간다([loadApproved] — TransformRegistry 가 reload 때 호출).
 * 레지스트리는 이 빈을 @Lazy 로 받고(생성 순환: registry → loader(this) → registry), 상태 전이 후 [TransformRegistry.reload].
 */
@Service
class PluginScriptService(
    private val repo: PluginScriptRepository,
    private val rt: ScriptRuntime,
    private val workspace: WorkspaceService,
    private val json: JsonService,
    @Lazy private val registry: TransformRegistry,
    @Lazy private val usages: PluginUsageIndex,
) : ScriptPluginLoader {
    private val log = LoggerFactory.getLogger(PluginScriptService::class.java)
    private fun tenant() = TenantContext.getTenantId()
    private fun me() = workspace.currentUsername()
    private fun requireApproved() { if (!workspace.isApproved(me())) throw ForbiddenException("플러그인 작성·시험은 가입 승인 후 가능합니다.") }
    private fun requireAdmin() { if (!workspace.isAdmin(me())) throw ForbiddenException("플러그인 승인/반려는 관리자만 가능합니다.") }
    private fun find(id: UUID): PluginScript = repo.findByIdAndTenantId(id, tenant()).orElseThrow { NotFoundException("플러그인 스크립트가 없습니다: $id") }

    // ---- 레지스트리 로더 ----
    override fun loadApproved(): List<Any> = repo.findByLiveSourceIsNotNull().mapNotNull { row ->
        try { rt.compile(row.liveSource!!, row.pluginId).toPlugin(rt) }
        catch (e: Exception) { log.warn("승인된 스크립트 플러그인 컴파일 실패(건너뜀): {} — {}", row.pluginId, e.message); null }
    }

    // ---- 조회 ----
    @Transactional(readOnly = true) fun list(): List<PluginScriptDtos.Summary> = repo.findByTenantIdOrderByUpdatedAtDesc(tenant()).map { summary(it) }
    @Transactional(readOnly = true) fun get(id: UUID): PluginScriptDtos.Detail = detail(find(id))
    @Transactional(readOnly = true) fun pendingCount(): Long = repo.countByTenantIdAndStatus(tenant(), PluginScript.STATUS_PENDING)

    // ---- 초안 저장 ----
    @Transactional
    fun create(req: PluginScriptDtos.SaveRequest): PluginScriptDtos.Detail {
        requireApproved()
        val src = req.source?.takeIf { it.isNotBlank() } ?: throw BadRequestException("source 가 비었습니다.")
        val cs = rt.compile(src)
        if (repo.existsByTenantIdAndPluginId(tenant(), cs.meta.id)) throw BadRequestException("같은 id 의 플러그인이 이미 있습니다: ${cs.meta.id}")
        // saveAndFlush: createdAt 은 @CreationTimestamp — Hibernate 가 flush 시점에만 채운다(Task 5 관례), save() 직후 detail() 이 바로 읽는다.
        val row = repo.saveAndFlush(PluginScript.create(tenant(), cs.meta.id, normName(req.name, cs.meta.label), cs.meta.kind, src, me()))
        return detail(row, cs)
    }

    @Transactional
    fun update(id: UUID, req: PluginScriptDtos.SaveRequest): PluginScriptDtos.Detail {
        requireApproved()
        val row = find(id)
        var cs: CompiledScript? = null
        req.source?.let { src ->
            cs = rt.compile(src)
            if (cs!!.meta.id != row.pluginId) {
                if (repo.existsByTenantIdAndPluginId(tenant(), cs!!.meta.id)) throw BadRequestException("같은 id 의 플러그인이 이미 있습니다: ${cs!!.meta.id}")
                if (row.liveSource != null) throw BadRequestException("승인된 플러그인의 id(${row.pluginId})는 바꿀 수 없습니다 — 새 플러그인으로 만드세요.")
                row.pluginId = cs!!.meta.id
            }
            row.source = src; row.kind = cs!!.meta.kind
            if (row.status == PluginScript.STATUS_PENDING || row.status == PluginScript.STATUS_REJECTED) row.status = PluginScript.STATUS_DRAFT
        }
        req.name?.let { row.name = normName(it, row.name) }
        return detail(repo.save(row), cs)
    }

    // ---- 시험 실행(샌드박스, 저장 없음) ----
    fun tryRun(req: PluginScriptDtos.TryRequest): PluginScriptDtos.TryResult {
        requireApproved()
        val src = req.source?.takeIf { it.isNotBlank() } ?: throw BadRequestException("source 가 비었습니다.")
        val cs = rt.compile(src)
        val meta = PluginScriptDtos.MetaView.of(cs.meta)
        val hasInput = req.inputs != null || req.value != null || req.bytesB64 != null
        if (!hasInput) return PluginScriptDtos.TryResult(meta)
        return when (cs.meta.kind) {
            ScriptMeta.TRANSFORM -> rt.runTransform(cs, req.inputs ?: emptyMap(), req.config ?: emptyMap()).let { PluginScriptDtos.TryResult(meta, outputs = it.value, logs = it.logs, durationMs = it.durationMs) }
            ScriptMeta.FIELD_CODEC -> rt.runFieldCodec(cs, req.value ?: "", fnOf(req.fn), codecCtx(req)).let { PluginScriptDtos.TryResult(meta, result = it.value, logs = it.logs, durationMs = it.durationMs) }
            else -> rt.runMessageCodec(cs, fnOf(req.fn), Base64.getDecoder().decode(req.bytesB64 ?: ""), codecCtx(req)).let { PluginScriptDtos.TryResult(meta, bytesB64 = Base64.getEncoder().encodeToString(it.value), logs = it.logs, durationMs = it.durationMs) }
        }
    }
    private fun fnOf(fn: String?) = if (fn == "decode") "decode" else "encode"
    private fun codecCtx(req: PluginScriptDtos.TryRequest) = CodecCtx(null, req.message ?: emptyMap(), req.config ?: emptyMap(), if (req.direction == "recv") "recv" else "send")

    // ---- 상태 전이 ----
    @Transactional
    fun submit(id: UUID): PluginScriptDtos.Detail {
        requireApproved()
        val row = find(id)
        rt.compile(row.source) // 제출 시점에도 컴파일되는지
        row.status = PluginScript.STATUS_PENDING; row.submittedBy = me(); row.submittedAt = Instant.now(); row.reviewNote = null
        return detail(repo.save(row))
    }

    @Transactional
    fun withdraw(id: UUID): PluginScriptDtos.Detail {
        requireApproved()
        val row = find(id)
        if (row.status != PluginScript.STATUS_PENDING) throw BadRequestException("승인 대기 중이 아닙니다.")
        row.status = PluginScript.STATUS_DRAFT
        return detail(repo.save(row))
    }

    @Transactional
    fun approve(id: UUID): PluginScriptDtos.Detail {
        requireAdmin()
        val row = find(id)
        if (row.status != PluginScript.STATUS_PENDING) throw BadRequestException("승인 대기 중이 아닙니다.")
        rt.compile(row.source)
        row.liveSource = row.source; row.status = PluginScript.STATUS_APPROVED; row.reviewedBy = me(); row.reviewedAt = Instant.now(); row.reviewNote = null
        val saved = repo.save(row)
        registry.reload()
        return detail(saved)
    }

    @Transactional
    fun reject(id: UUID, note: String?): PluginScriptDtos.Detail {
        requireAdmin()
        val row = find(id)
        if (row.status != PluginScript.STATUS_PENDING) throw BadRequestException("승인 대기 중이 아닙니다.")
        row.status = PluginScript.STATUS_REJECTED; row.reviewedBy = me(); row.reviewedAt = Instant.now(); row.reviewNote = note?.take(1000)
        return detail(repo.save(row))
    }

    @Transactional
    fun delete(id: UUID) {
        val row = find(id)
        if (row.createdBy != me() && !workspace.isAdmin(me())) throw ForbiddenException("작성자 또는 관리자만 삭제할 수 있습니다.")
        val n = usages.count(row.pluginId)
        if (n > 0) throw BadRequestException("사용 중인 플러그인은 삭제할 수 없습니다(사용처 ${n}곳) — 먼저 워크플로/Mock/프로토콜에서 제거하세요.")
        repo.delete(row)
        if (row.liveSource != null) registry.reload()
    }

    /** 제출자가 돌린 샘플을 승인 화면용으로 저장(프론트가 try 결과를 submit 전에 PUT). */
    @Transactional
    fun saveSample(id: UUID, sampleJson: String?) { requireApproved(); val row = find(id); row.sampleJson = sampleJson?.take(20_000); repo.save(row) }

    // ---- 뷰 ----
    private fun normName(name: String?, fallback: String): String {
        val n = name?.trim().orEmpty().ifEmpty { fallback }
        if (n.length > 120) throw BadRequestException("이름은 120자 이하여야 합니다.")
        return n
    }
    private fun summary(r: PluginScript) = PluginScriptDtos.Summary(r.id, r.pluginId, r.name, r.kind, r.status, r.liveSource != null,
        r.liveSource != null && r.liveSource != r.source, usages.count(r.pluginId), r.updatedAt ?: r.createdAt, r.submittedBy, r.createdBy)
    private fun detail(r: PluginScript, cs: CompiledScript? = null): PluginScriptDtos.Detail {
        val meta = (cs ?: runCatching { rt.compile(r.source, r.pluginId) }.getOrNull())?.let { PluginScriptDtos.MetaView.of(it.meta) }
        return PluginScriptDtos.Detail(r.id, r.pluginId, r.name, r.kind, r.status, r.liveSource != null, r.liveSource != null && r.liveSource != r.source,
            usages.count(r.pluginId), r.updatedAt ?: r.createdAt, r.submittedBy, r.submittedAt, r.createdBy,
            r.source, r.liveSource, r.sampleJson, r.reviewNote, r.reviewedBy, r.reviewedAt, meta)
    }
}
