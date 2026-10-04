package com.flowlink.desktop

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.web.servlet.FilterRegistrationBean
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.core.Ordered
import org.springframework.http.ResponseCookie
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.filter.OncePerRequestFilter

@Configuration
@Profile("desktop")
class DesktopConfig {
    @Bean
    fun multipartResolver(): org.springframework.web.multipart.MultipartResolver = object : org.springframework.web.multipart.support.StandardServletMultipartResolver() {
        override fun isMultipart(request: HttpServletRequest): Boolean =
            !request.requestURI.startsWith("/api/v1/remote/") && super.isMultipart(request)
    }
    @Bean
    fun desktopAccess(session: DesktopSession): FilterRegistrationBean<DesktopAccessFilter> =
        FilterRegistrationBean(DesktopAccessFilter(session)).also { it.order = Ordered.HIGHEST_PRECEDENCE }
}

class DesktopAccessFilter(private val session: DesktopSession) : OncePerRequestFilter() {
    override fun doFilterInternal(req: HttpServletRequest, res: HttpServletResponse, chain: FilterChain) {
        val path = req.requestURI.removePrefix(req.contextPath)
        val host = req.getHeader("Host") ?: ""
        if (!Regex("(127\\.0\\.0\\.1|localhost):[0-9]{1,5}").matches(host)) {
            res.sendError(403, "허용되지 않은 로컬 호스트입니다."); return
        }
        // 사용자 정의 Mock HTML은 관리 화면과 다른 origin에서 실행한다.
        if (path.startsWith("/mock/") && host.startsWith("127.0.0.1:")) {
            res.status = 307
            res.setHeader("Location", "http://localhost:${req.serverPort}${req.requestURI}" +
                (req.queryString?.let { "?$it" } ?: ""))
            return
        }
        if (listOf("/mock/", "/relay/", "/hooks/").any { path.startsWith(it) }) {
            chain.doFilter(req, res); return
        }
        val origin = req.getHeader("Origin")
        if (!host.startsWith("127.0.0.1:") || (origin != null && origin != "http://$host")) {
            res.sendError(403, "관리 화면은 트레이에서 열어주세요."); return
        }
        if (path == "/desktop/open") {
            chain.doFilter(req, res); return
        }
        val credential = req.getHeader("X-FlowLink-Local") ?: req.cookies?.find { it.name == session.cookieName }?.value
        if (!session.accepts(credential)) {
            res.status = 401
            res.contentType = "application/json;charset=UTF-8"
            res.writer.write("{\"message\":\"트레이의 화면 열기로 접속하거나 설치된 MCP를 사용해주세요.\"}")
            return
        }
        chain.doFilter(req, res)
    }
}

@RestController
@Profile("desktop")
class DesktopController(private val session: DesktopSession, private val context: org.springframework.context.ConfigurableApplicationContext) {
    @PostMapping("/desktop/shutdown")
    fun shutdown() { Thread { Thread.sleep(500); context.close() }.start() }
    @PostMapping("/desktop/ticket")
    fun ticket(): Map<String, String> = mapOf("url" to session.browserUrl())

    @GetMapping("/desktop/open")
    fun open(@RequestParam ticket: String, @RequestParam(required = false) runtime: String?, res: HttpServletResponse) {
        if (!session.claimTicket(ticket)) { res.sendError(401, "연결이 만료되었습니다. 트레이에서 다시 열어주세요."); return }
        res.setHeader("Set-Cookie", ResponseCookie.from(session.cookieName, session.token)
            .httpOnly(true).sameSite("Strict").path("/").build().toString())
        res.setHeader("Cache-Control", "no-store")
        res.setHeader("Referrer-Policy", "no-referrer")
        res.sendRedirect(if (runtime == "server") "/?runtime=server" else "/")
    }
}
