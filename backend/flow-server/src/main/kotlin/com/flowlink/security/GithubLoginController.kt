package com.flowlink.security

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** 중앙 서버만 로그인 세션과 앱 JWT를 발급한다. Windows 앱은 원격 로그인 연결을 사용한다. */
@RestController
@RequestMapping("/api/v1/auth/github/device")
class GithubLoginController(private val github: GithubAuthService) {
    @PostMapping("/start")
    fun start(): GithubAuthService.DeviceStart = github.startDevice()

    @GetMapping("/poll")
    fun poll(@RequestParam session: String): GithubAuthService.PollResult = github.poll(session)
}
