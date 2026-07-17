package com.flowlink.trigger

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.FlowTrigger
import com.flowlink.core.domain.TriggerType
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FlowTriggerRepository
import com.flowlink.execution.ExecutionService
import com.flowlink.execution.dto.RunRequest
import org.slf4j.LoggerFactory
import org.springframework.scheduling.support.CronExpression
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.UUID

/**
 * 자동 실행 트리거 CRUD + 발화(스케줄러/웹훅).
 * 실행은 P2 비동기 워커 풀(ExecutionService.run)을 그대로 쓰고, 트리거는 tenant/trigger 종류만 세팅해 호출한다.
 */
@Service
class TriggerService(
    private val triggerRepo: FlowTriggerRepository,
    private val flowRepo: FlowRepository,
    private val executionService: ExecutionService,
    private val json: JsonService,
) {
    private val log = LoggerFactory.getLogger(TriggerService::class.java)
    private val zone: ZoneId = ZoneId.systemDefault()

    @Transactional(readOnly = true)
    fun list(flowId: UUID): List<TriggerView> {
        requireFlow(flowId)
        return triggerRepo.findByFlowIdAndTenantId(flowId, tenant()).map { TriggerView.from(it) }
    }

    @Transactional
    fun create(flowId: UUID, req: CreateTriggerRequest): TriggerView {
        requireFlow(flowId)
        if (req.type != TriggerType.SCHEDULE && req.type != TriggerType.WEBHOOK) {
            throw BadRequestException("트리거 종류는 SCHEDULE 또는 WEBHOOK 이어야 합니다.")
        }
        val t = FlowTrigger.create(tenant(), flowId, req.type)
        t.enabled = req.enabled
        t.versionNo = req.versionNo
        t.inputJson = req.input?.let { if (it.isNull) null else json.toJson(it) }
        if (req.type == TriggerType.SCHEDULE) {
            val cron = req.cron?.trim().orEmpty()
            t.cron = cron
            t.nextRunAt = computeNext(cron, Instant.now())
        } else {
            t.webhookToken = UUID.randomUUID().toString().replace("-", "")
        }
        return TriggerView.from(triggerRepo.save(t))
    }

    @Transactional
    fun update(id: UUID, req: UpdateTriggerRequest): TriggerView {
        val t = load(id)
        req.enabled?.let { t.enabled = it }
        req.versionNo?.let { t.versionNo = it }
        if (req.input != null) t.inputJson = if (req.input.isNull) null else json.toJson(req.input)
        if (t.type == TriggerType.SCHEDULE) {
            val cron = req.cron?.trim()
            if (cron != null) t.cron = cron
            // cron 변경 또는 재활성화 시 다음 발화 재계산(경과분 스킵)
            if (cron != null || req.enabled == true) {
                t.nextRunAt = computeNext(t.cron.orEmpty(), Instant.now())
            }
        }
        return TriggerView.from(t)
    }

    @Transactional
    fun delete(id: UUID) {
        triggerRepo.delete(load(id))
    }

    /**
     * 웹훅 발화 — 무인증 경로에서 호출(POST /hooks/{token}). 토큰으로 트리거를 찾아 tenant 를 세팅하고 실행.
     * 본문(input)은 RunRequest.input 으로 주입되며 트리거 저장 input 과 병합하지 않고 본문 우선(있으면).
     */
    fun fireWebhook(token: String, body: com.fasterxml.jackson.databind.JsonNode?): UUID {
        val t = triggerRepo.findByWebhookToken(token)
            .orElseThrow { NotFoundException.of("Webhook", token) }
        if (!t.enabled) throw NotFoundException.of("Webhook", token) // 비활성은 존재 은닉
        val input = if (body != null && !body.isNull && body.isObject) body
        else t.inputJson?.let { json.readTree(it) }
        TenantContext.setTenantId(t.tenantId)
        try {
            val detail = executionService.run(t.flowId, RunRequest(input, null, t.versionNo, null, null), TriggerType.WEBHOOK)
            markFired(t.id)
            return detail.id
        } finally {
            TenantContext.clear()
        }
    }

    /** 발화할 SCHEDULE 트리거 id 목록 — 스케줄러가 각 id 로 fireSchedule 을 (프록시 경유) 호출한다. */
    @Transactional(readOnly = true)
    fun dueScheduleIds(now: Instant): List<UUID> =
        triggerRepo.findByTypeAndEnabledTrueAndNextRunAtLessThanEqual(TriggerType.SCHEDULE, now).map { it.id }

    @Transactional
    fun fireSchedule(triggerId: UUID, now: Instant) {
        val t = triggerRepo.findById(triggerId).orElse(null) ?: return
        if (!t.enabled || t.type != TriggerType.SCHEDULE) return
        val input = t.inputJson?.let { json.readTree(it) }
        TenantContext.setTenantId(t.tenantId)
        try {
            executionService.run(t.flowId, RunRequest(input, null, t.versionNo, null, null), TriggerType.SCHEDULE)
        } finally {
            TenantContext.clear()
        }
        t.lastRunAt = now
        t.nextRunAt = computeNext(t.cron.orEmpty(), now)
    }

    @Transactional
    fun advance(triggerId: UUID, from: Instant) {
        val t = triggerRepo.findById(triggerId).orElse(null) ?: return
        t.nextRunAt = computeNext(t.cron.orEmpty(), from)
    }

    @Transactional
    fun markFired(triggerId: UUID) {
        triggerRepo.findById(triggerId).ifPresent { it.lastRunAt = Instant.now() }
    }

    // --- 내부 ---

    private fun computeNext(cron: String, from: Instant): Instant {
        if (cron.isBlank()) throw BadRequestException("cron 식이 필요합니다.")
        val expr = try { CronExpression.parse(cron) } catch (e: IllegalArgumentException) {
            throw BadRequestException("cron 식이 올바르지 않습니다: ${e.message}")
        }
        val base = ZonedDateTime.ofInstant(from, zone)
        val next = expr.next(base) ?: throw BadRequestException("cron 식에서 다음 실행 시각을 계산할 수 없습니다.")
        return next.toInstant()
    }

    private fun requireFlow(flowId: UUID) {
        flowRepo.findByIdAndTenantId(flowId, tenant())
            .orElseThrow { NotFoundException.of("Flow", flowId) }
    }

    private fun load(id: UUID): FlowTrigger =
        triggerRepo.findByIdAndTenantId(id, tenant())
            .orElseThrow { NotFoundException.of("Trigger", id) }

    private fun tenant(): String = TenantContext.getTenantId()
}
