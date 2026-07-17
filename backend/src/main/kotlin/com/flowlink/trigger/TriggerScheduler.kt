package com.flowlink.trigger

import jakarta.annotation.PostConstruct
import jakarta.annotation.PreDestroy
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * SCHEDULE 트리거 폴러 — 고정 주기로 발화 시각이 지난 트리거를 찾아 실행한다.
 * @Scheduled 대신 전용 단일 스레드 스케줄러(코드베이스 관례). 트리거별 발화는 TriggerService(프록시)를
 * 경유해 @Transactional 이 적용되게 한다. 단일 인스턴스 스코프(수평 확장 시 분산 락 필요 — 범위 밖).
 */
@Component
class TriggerScheduler(private val service: TriggerService) {

    private val log = LoggerFactory.getLogger(TriggerScheduler::class.java)
    private val exec: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "flowlink-trigger").apply { isDaemon = true }
    }

    @PostConstruct
    fun start() {
        // 기동 15초 후 시작, 이후 20초 간격. 초 단위 cron 도 20초 해상도로 발화(테스트 도구엔 충분).
        exec.scheduleWithFixedDelay({ tick() }, 15, 20, TimeUnit.SECONDS)
        log.info("트리거 스케줄러 시작(20초 폴링)")
    }

    private fun tick() {
        val now = Instant.now()
        val ids = try { service.dueScheduleIds(now) } catch (e: Exception) {
            log.warn("트리거 폴링 조회 실패: {}", e.message); return
        }
        for (id in ids) {
            try {
                service.fireSchedule(id, now)
            } catch (e: Exception) {
                log.warn("스케줄 트리거 발화 실패 {}: {}", id, e.message)
                // 실패해도 다음 발화 시각은 전진(폭주 방지)
                try { service.advance(id, now) } catch (_: Exception) {}
            }
        }
    }

    @PreDestroy
    fun stop() {
        exec.shutdownNow()
    }
}
