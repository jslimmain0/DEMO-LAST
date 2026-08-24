package com.flowlink.common.web

import com.flowlink.common.tenant.TenantContext
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.LoggerFactory
import org.slf4j.MDC
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter
import java.util.concurrent.atomic.AtomicLong

/**
 * 접근 로그 + 요청 상관관계(MDC) 필터.
 *
 * 모든 요청에 짧은 요청 ID(`reqId`)를 부여해 MDC 에 넣는다 → 그 요청이 남긴 **모든 로그 줄**에
 * 같은 ID 가 붙어(로그 패턴 `%X{reqId}`) 한 요청의 흐름을 추적할 수 있다.
 *
 * 소음 관리(레벨 정책):
 * - 조회(GET/HEAD) 성공 → DEBUG (평소엔 안 보임, 디버깅 때 `logging.level.com.flowlink=DEBUG`)
 * - 변경(POST/PUT/PATCH/DELETE) 성공 → INFO — "누가 무엇을 바꿨나"는 남긴다
 * - 4xx → INFO(클라이언트 실수) · 5xx → ERROR · 느린 요청(임계 초과) → WARN
 * - actuator/정적 리소스/swagger 는 제외(헬스체크가 로그를 덮지 않게)
 *
 * ⚠ 쿼리스트링/본문은 찍지 않는다(토큰·시크릿이 섞일 수 있음 — 경로·상태·시간만).
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
class RequestLogFilter : OncePerRequestFilter() {

    override fun shouldNotFilter(request: HttpServletRequest): Boolean {
        val p = request.requestURI
        return SKIP_PREFIXES.any { p.startsWith(it) } || SKIP_SUFFIXES.any { p.endsWith(it) }
    }

    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        chain: FilterChain,
    ) {
        val reqId = nextId()
        MDC.put(MDC_REQ_ID, "r:$reqId") // 로그 패턴(%X{reqId})에 그대로 찍히도록 접두사 포함
        response.setHeader("X-Request-Id", reqId)
        val started = System.nanoTime()
        try {
            chain.doFilter(request, response)
        } finally {
            val ms = (System.nanoTime() - started) / 1_000_000
            try {
                logAccess(request, response, ms)
            } catch (e: Exception) {
                log.debug("접근 로그 기록 실패: {}", e.message)
            }
            MDC.remove(MDC_REQ_ID)
        }
    }

    private fun logAccess(req: HttpServletRequest, res: HttpServletResponse, ms: Long) {
        val status = res.status
        val method = req.method
        // 신원은 체인이 끝난 뒤에야 확정된다(인증 필터가 뒤에 있음)
        val who = user() ?: "-"
        val tenant = try { TenantContext.getTenantId() } catch (e: Exception) { "-" }
        val slow = ms >= SLOW_MS
        val msg = "{} {} → {} ({}ms) user={} tenant={}"
        val args = arrayOf<Any?>(method, req.requestURI, status, ms, who, tenant)
        when {
            status >= 500 -> log.error(msg, *args)
            slow -> log.warn("느린 요청: $msg", *args)
            status >= 400 -> log.info(msg, *args)
            method == "GET" || method == "HEAD" || method == "OPTIONS" -> log.debug(msg, *args)
            else -> log.info(msg, *args)
        }
    }

    private fun user(): String? =
        try {
            SecurityContextHolder.getContext().authentication
                ?.takeIf { it.isAuthenticated && it.name != "anonymousUser" }?.name
        } catch (e: Exception) {
            null
        }

    companion object {
        private val log = LoggerFactory.getLogger(RequestLogFilter::class.java)
        const val MDC_REQ_ID = "reqId"

        /** 느린 요청 경고 임계(ms) — 워크플로 실행은 비동기라 API 자체는 짧아야 정상. */
        private const val SLOW_MS = 3000L

        private val SKIP_PREFIXES = listOf("/actuator", "/assets/", "/swagger-ui", "/v3/api-docs", "/h2-console")
        private val SKIP_SUFFIXES = listOf(".js", ".css", ".map", ".svg", ".png", ".ico", ".woff", ".woff2")

        private val SEQ = AtomicLong(0)

        /** 짧고 읽기 쉬운 요청 ID(로그 grep 용) — 프로세스 내 단조 증가 + 36진수. */
        private fun nextId(): String = java.lang.Long.toString(SEQ.incrementAndGet(), 36).padStart(4, '0')
    }
}
