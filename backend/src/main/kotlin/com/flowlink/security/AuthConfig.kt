package com.flowlink.security

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.oauth2.jwt.JwtDecoder

/**
 * GitHub 로그인 모드 활성 시 앱 자체 JWT(HS256) 디코더를 리소스 서버 빈으로 등록.
 * 이 빈이 존재하면 [SecurityConfig] 가 GitHub 게스트 모드(앱 개방, assistant 만 로그인 필수)로 전환된다.
 * github.enabled=false(dev)면 빈 없음 → permitAll.
 */
@Configuration
class AuthConfig {

    @Bean
    @ConditionalOnProperty(prefix = "flowlink.auth", name = ["github-enabled"], havingValue = "true")
    fun appJwtDecoder(appJwt: AppJwt): JwtDecoder = appJwt.decoder()
}

