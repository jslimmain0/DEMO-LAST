package com.flowlink.server

import com.flowlink.distribution.DistributionController
import com.flowlink.presence.PresenceConfig
import com.flowlink.presence.PresenceHandler
import com.flowlink.security.AppJwt
import com.flowlink.security.AuthConfig
import com.flowlink.security.GithubAuthService
import com.flowlink.security.GithubLoginController
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Import

/** 중앙 서버의 로그인 발급·배포·공동 편집 구성. desktop용 일반 JAR에는 포함하지 않는다. */
@Configuration
@Import(DistributionController::class, PresenceConfig::class, PresenceHandler::class,
    AppJwt::class, AuthConfig::class, GithubAuthService::class, GithubLoginController::class,
    com.flowlink.server.bridge.DesktopBridgeService::class, com.flowlink.server.bridge.DesktopBridgeController::class)
class ServerFeatures
