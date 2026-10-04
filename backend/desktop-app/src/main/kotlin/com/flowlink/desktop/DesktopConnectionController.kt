package com.flowlink.desktop

import jakarta.servlet.http.HttpServletRequest
import org.springframework.context.annotation.Profile
import org.springframework.web.bind.annotation.*

@RestController
@Profile("desktop")
class DesktopConnectionController(private val connection: DesktopConnection, private val tray: DesktopTray) {
    data class Configure(val serverUrl: String)
    @GetMapping("/api/v1/desktop/connection") fun view() = connection.view()
    @PutMapping("/api/v1/desktop/connection") fun configure(@RequestBody req: Configure) = connection.configure(req.serverUrl)
    @PostMapping("/api/v1/desktop/login/start") fun start() = connection.start()
    @PostMapping("/api/v1/desktop/login/native") fun nativeLogin() { tray.loginDialog() }
    @GetMapping("/api/v1/desktop/login/poll") fun poll() = connection.poll()
    @PostMapping("/api/v1/desktop/logout") fun logout() { connection.logout() }
    @RequestMapping("/api/v1/remote/**") fun forward(req: HttpServletRequest) = connection.forward(req)
}
