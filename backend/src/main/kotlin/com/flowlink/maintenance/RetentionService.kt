package com.flowlink.maintenance

import com.flowlink.core.domain.ExecutionStatus
import com.flowlink.core.repository.ExecutionRepository
import com.flowlink.core.repository.FlowVersionRepository
import com.flowlink.core.repository.NodeExecutionRepository
import jakarta.annotation.PostConstruct
import jakarta.annotation.PreDestroy
import org.slf4j.LoggerFactory
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.stereotype.Component
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Duration
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * flowlink.retention.* — DB 무한 성장(부하) 방지 자동 보존 정책.
 *
 * @property executionDays 실행 이력 보존 일수 — 이보다 오래된 **끝난** 실행(+노드 기록)을 자동 삭제.
 *   0 이하 = 끄기. 기본 90일. env `FLOWLINK_RETENTION_EXECUTION_DAYS`.
 * @property flowVersionsKeep flow 당 유지할 버전 스냅샷 수 — 그보다 오래된 버전 중 실행 이력·트리거가
 *   참조하지 않는 것만 삭제(자동 저장이 쌓는 그래프 CLOB 성장 억제). 0 이하 = 끄기. 기본 100.
 *   env `FLOWLINK_RETENTION_FLOW_VERSIONS_KEEP`.
 */
@ConfigurationProperties(prefix = "flowlink.retention")
class RetentionProperties(
    executionDays: Int? = null,
    flowVersionsKeep: Int? = null,
) {
    val executionDays: Int = executionDays ?: 90
    val flowVersionsKeep: Int = flowVersionsKeep ?: 100
}

/** 보존 정리 본체 — 스케줄러(프록시 경유 호출)와 분리해 @Transactional 이 적용되게 한다(코드베이스 관례). */
@Service
class RetentionService(
    private val props: RetentionProperties,
    private val executionRepo: ExecutionRepository,
    private val nodeExecRepo: NodeExecutionRepository,
    private val versionRepo: FlowVersionRepository,
) {
    private val log = LoggerFactory.getLogger(RetentionService::class.java)

    /** 실행 이력 보존 — RUNNING/WAITING 은 보호. 삭제 건수 반환. */
    @Transactional
    fun sweepExecutions(): Int {
        if (props.executionDays <= 0) return 0
        val before = Instant.now().minus(Duration.ofDays(props.executionDays.toLong()))
        val active = listOf(ExecutionStatus.RUNNING, ExecutionStatus.WAITING)
        nodeExecRepo.purgeBefore(before, active)
        val removed = executionRepo.purgeBefore(before, active)
        if (removed > 0) log.info("보존 정리(실행 이력): {}일 이전 {}건 삭제", props.executionDays, removed)
        return removed
    }

    /** 버전 스냅샷 보존 — flow 당 최신 keep 개 유지, 실행/트리거가 참조하는 버전은 남김. */
    @Transactional
    fun sweepFlowVersions(): Int {
        if (props.flowVersionsKeep <= 0) return 0
        val removed = versionRepo.pruneOldVersions(props.flowVersionsKeep)
        if (removed > 0) log.info("보존 정리(버전 스냅샷): flow 당 최신 {}개 유지 — {}건 삭제", props.flowVersionsKeep, removed)
        return removed
    }
}

/**
 * 보존 정리 스케줄러 — 기동 90초 후 1회 + 6시간마다. 전용 데몬 스레드(TriggerScheduler 와 동일 관례).
 * 단일 인스턴스 스코프. 실패는 로깅만(다음 주기에 재시도) — 앱 동작에 영향 없음.
 */
@Component
class RetentionScheduler(
    private val service: RetentionService,
    private val props: RetentionProperties,
) {
    private val log = LoggerFactory.getLogger(RetentionScheduler::class.java)
    private val exec: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "flowlink-retention").apply { isDaemon = true }
    }

    @PostConstruct
    fun start() {
        if (props.executionDays <= 0 && props.flowVersionsKeep <= 0) {
            log.info("보존 정리 꺼짐(retention.execution-days=0, flow-versions-keep=0)")
            return
        }
        exec.scheduleWithFixedDelay({ tick() }, 90, TimeUnit.HOURS.toSeconds(6), TimeUnit.SECONDS)
        log.info("보존 정리 스케줄러 시작 — 실행 이력 {}일 / flow 당 버전 {}개 유지(6시간 주기)",
            props.executionDays, props.flowVersionsKeep)
    }

    private fun tick() {
        try { service.sweepExecutions() } catch (e: Exception) { log.warn("실행 이력 보존 정리 실패: {}", e.message) }
        try { service.sweepFlowVersions() } catch (e: Exception) { log.warn("버전 보존 정리 실패: {}", e.message) }
    }

    @PreDestroy
    fun stop() { exec.shutdownNow() }
}
