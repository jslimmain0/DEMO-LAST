package com.flowlink.security

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.stereotype.Component

/**
 * GitHub 로그인 모드 활성 시 앱 자체 JWT(HS256) 디코더를 리소스 서버 빈으로 등록.
 * 이 빈이 존재하면 [SecurityConfig] 가 인증 필수 모드로 전환된다(issuer-uri 없이도).
 * github.enabled=false(dev)면 빈 없음 → permitAll.
 */
@Configuration
class AuthConfig {

    @Bean
    @ConditionalOnProperty(prefix = "flowlink.auth", name = ["github-enabled"], havingValue = "true")
    fun appJwtDecoder(appJwt: AppJwt): JwtDecoder = appJwt.decoder()
}

/**
 * GitHub 로그인 모드 기동 가드.
 * - **jwt-secret 은 필수(fail-closed)** — 미설정 시 공개 dev 키로 서명돼 로그인 없이도 admin 토큰 위조가 가능하므로 기동을 막는다.
 *   시크릿은 env(FLOWLINK_AUTH_JWT_SECRET, 로컬) 또는 Vault(flowlink-config/jwt-secret, 운영) 어느 쪽이든 되며([AppJwt.hasSecret]),
 *   둘 다 없으면 기동을 실패시킨다.
 */
@Component
@ConditionalOnProperty(prefix = "flowlink.auth", name = ["github-enabled"], havingValue = "true")
class GithubAuthStartupValidator(appJwt: AppJwt) {
    init {
        check(appJwt.hasSecret) {
            "GitHub 로그인 활성(FLOWLINK_AUTH_GITHUB_ENABLED=true) 시 서명 시크릿이 필수입니다 " +
                "— env FLOWLINK_AUTH_JWT_SECRET(로컬) 또는 Vault(flowlink-config 경로의 jwt-secret, 운영)로 설정하세요. " +
                "미설정 시 공개된 dev 폴백 키로 서명돼 누구나 관리자 토큰을 위조할 수 있습니다."
        }
    }
}
