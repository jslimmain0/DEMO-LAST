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
        // 할당식 UUID 엔티티는 save 가 merge 로 동작 → @CreationTimestamp createdAt 은 saveAndFlush 가 반환한
        // 관리 인스턴스에만 채워진다(FlowVersion 과 동일 이유). 원본 t 를 읽으면 lateinit 미초기화 예외.
        return TriggerView.from(triggerRepo.saveAndFlush(t))
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

    /** 발화 스펙 — claim(트랜잭션) 이 확정해 run(비트랜잭션) 으로 넘긴다. */
    data class FireSpec(val tenantId: String, val flowId: UUID, val versionNo: Int?, val inputJson: String?)

    /**
     * 웹훅 claim — 토큰으로 트리거를 찾아 lastRunAt 갱신 후 실행 스펙 반환(비활성/미존재는 null=존재 은닉).
     * @Transactional 이라 lastRunAt 이 실제로 영속된다(구: fireWebhook 자기호출로 프록시 우회돼 미영속이던 버그 수정).
     */
    @Transactional
    fun claimWebhookFire(token: String, body: com.fasterxml.jackson.databind.JsonNode?): FireSpec? {
        val t = triggerRepo.findByWebhookToken(token).orElse(null) ?: return null
        if (!t.enabled) return null
        if (flowGone(t.flowId)) { // 삭제(archive)된 flow 의 웹훅도 발화 금지 + 자동 비활성
            log.warn("웹훅 트리거 자동 비활성 — flow 가 삭제됨(trigger={}, flow={})", t.id, t.flowId)
            t.enabled = false
            return null
        }
        t.lastRunAt = Instant.now()
        // 본문(JSON object)이 있으면 그걸 input 으로, 없으면 트리거 저장 input
        val inputJson = if (body != null && !body.isNull && body.isObject) json.toJson(body) else t.inputJson
        return FireSpec(t.tenantId, t.flowId, t.versionNo, inputJson)
    }

    /** 발화할 SCHEDULE 트리거 id 목록 — 스케줄러가 각 id 로 claimScheduleFire 를 (프록시 경유) 호출한다. */
    @Transactional(readOnly = true)
    fun dueScheduleIds(now: Instant): List<UUID> =
        triggerRepo.findByTypeAndEnabledTrueAndNextRunAtLessThanEqual(TriggerType.SCHEDULE, now).map { it.id }

    /**
     * 스케줄 claim — nextRunAt 을 **미리** 전진(중복 발화 방지, 실패해도 폭주 없음) + lastRunAt, 실행 스펙 반환.
     * 실행(run)은 이 트랜잭션 커밋 **후** 비트랜잭션 runFire 에서 — 그래야 executionRepo.save(execution) 이
     * 즉시 커밋돼 비동기 워커가 execution 행을 본다(구: fireSchedule @Transactional 안에서 run 을 불러 커밋 전
     * 워커가 시작 → FK 위반/NotFound → RUNNING 고착·노드 기록 유실이던 HIGH 버그 수정).
     */
    @Transactional
    fun claimScheduleFire(triggerId: UUID, now: Instant): FireSpec? {
        val t = triggerRepo.findById(triggerId).orElse(null) ?: return null
        if (!t.enabled || t.type != TriggerType.SCHEDULE) return null
        // flow 가 삭제(archive)됐으면 트리거 자동 비활성 — 유령 스케줄이 이력을 무한 오염하던 버그(삭제 후에도 20초마다 발화).
        if (flowGone(t.flowId)) {
            log.warn("스케줄 트리거 자동 비활성 — flow 가 삭제됨(trigger={}, flow={})", t.id, t.flowId)
            t.enabled = false
            return null
        }
        t.lastRunAt = now
        t.nextRunAt = computeNext(t.cron.orEmpty(), now)
        return FireSpec(t.tenantId, t.flowId, t.versionNo, t.inputJson)
    }

    /** flow 부재/보관(archive) 여부 — 트리거 발화 가드. */
    private fun flowGone(flowId: UUID): Boolean =
        flowRepo.findByIdAndTenantId(flowId, TenantContext.SHARED_FLOW_TENANT).map { it.archived }.orElse(true)

    /** 실제 실행 — **비트랜잭션**(ambient tx 없음)이라 run() 의 Execution INSERT 가 즉시 커밋된다. */
    fun runFire(spec: FireSpec, trigger: TriggerType): UUID {
        val input = spec.inputJson?.let { json.readTree(it) }
        TenantContext.setTenantId(spec.tenantId)
        try {
            return executionService.run(spec.flowId, RunRequest(input, null, null, spec.versionNo), trigger).id
        } finally {
            TenantContext.clear()
        }
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
        // flow 는 전역 공유 — 공유 테넌트로 존재 확인(트리거 행 자체는 아래 load() 처럼 사용자 테넌트 유지).
        flowRepo.findByIdAndTenantId(flowId, TenantContext.SHARED_FLOW_TENANT)
            .orElseThrow { NotFoundException.of("Flow", flowId) }
    }

    private fun load(id: UUID): FlowTrigger =
        triggerRepo.findByIdAndTenantId(id, tenant())
            .orElseThrow { NotFoundException.of("Trigger", id) }

    private fun tenant(): String = TenantContext.getTenantId()
}
