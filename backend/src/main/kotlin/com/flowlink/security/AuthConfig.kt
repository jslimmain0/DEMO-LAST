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
 * GitHub 로그인 모드 **fail-closed 가드** — 활성 시 필수 설정을 강제해 안전하지 않은 기본값으로의 기동을 막는다.
 * (검증 없이 켜면: 미설정 jwt-secret → 공개 dev 키로 토큰 위조 가능 / 빈 화이트리스트 → 인증한 누구나 전권 admin.)
 * 하나라도 빠지면 기동을 **명시적으로 실패**시켜 운영 오설정을 배포 시점에 잡는다.
 */
@Component
@ConditionalOnProperty(prefix = "flowlink.auth", name = ["github-enabled"], havingValue = "true")
class GithubAuthStartupValidator(props: AuthProperties) {
    init {
        check(props.jwtSecret != null) {
            "GitHub 로그인 활성(FLOWLINK_AUTH_GITHUB_ENABLED=true) 시 FLOWLINK_AUTH_JWT_SECRET 이 필수입니다 " +
                "— 미설정 시 공개된 dev 폴백 키로 서명돼 누구나 관리자 토큰을 위조할 수 있습니다."
        }
        check(props.allowedLogins.isNotEmpty()) {
            "GitHub 로그인 활성 시 FLOWLINK_AUTH_ALLOWED_LOGINS 이 필수입니다(허용 GitHub 로그인 목록) " +
                "— 비우면 인증한 누구나 전권(admin+platform-admin)을 받습니다. 예: FLOWLINK_AUTH_ALLOWED_LOGINS=alice,bob"
        }
    }
}
