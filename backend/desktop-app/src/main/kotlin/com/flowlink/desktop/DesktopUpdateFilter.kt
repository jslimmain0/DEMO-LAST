package com.flowlink.desktop

import com.flowlink.common.lifecycle.RuntimeUpdateGate
import com.flowlink.common.lifecycle.UpdateInProgressException
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.web.servlet.FilterRegistrationBean
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.core.Ordered
import org.springframework.web.filter.OncePerRequestFilter

@Configuration
@Profile("desktop")
class DesktopUpdateFilterConfig {
    @Bean
    fun desktopUpdateFilter(gate: RuntimeUpdateGate) = FilterRegistrationBean(DesktopUpdateFilter(gate)).also {
        it.order = Ordered.HIGHEST_PRECEDENCE + 1
    }
}

class DesktopUpdateFilter(private val gate: RuntimeUpdateGate) : OncePerRequestFilter() {
    override fun doFilterInternal(req: HttpServletRequest, res: HttpServletResponse, chain: FilterChain) {
        val path = req.requestURI.removePrefix(req.contextPath)
        val guarded = !path.startsWith("/api/v1/desktop/update") &&
            ((path.startsWith("/api/") && req.method !in setOf("GET", "HEAD", "OPTIONS")) ||
                listOf("/mock/", "/relay/", "/hooks/").any(path::startsWith))
        if (!guarded) { chain.doFilter(req, res); return }
        try { gate.work { chain.doFilter(req, res) } }
        catch (_: UpdateInProgressException) {
            res.status = 503
            res.contentType = "application/json;charset=UTF-8"
            res.writer.write("{\"message\":\"업데이트 설치를 준비 중입니다. 앱이 다시 열린 후 시도하세요.\"}")
        }
    }
}
