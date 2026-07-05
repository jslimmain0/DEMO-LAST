package com.flowlink.security

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.config.Customizer
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter
import org.springframework.security.web.SecurityFilterChain
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.CorsConfigurationSource
import org.springframework.web.cors.UrlBasedCorsConfigurationSource

/**
 * 보안 구성 (IdP 비종속).
 *
 * **동작 모드**는 `spring.security.oauth2.resourceserver.jwt.issuer-uri` 설정 유무로 자동 결정된다:
 * - **운영(issuer-uri 설정 시)**: OIDC JWT 리소스 서버로 동작 — `/api` 이하는 인증 필수,
 *   [TenantClaimFilter] 가 JWT 테넌트 클레임을 [com.flowlink.common.tenant.TenantContext] 에 주입.
 *   어떤 OIDC IdP(Auth0/Cognito/Entra/Keycloak)와도 호환.
 * - **개발(issuer-uri 미설정)**: 모든 요청 허용(permitAll) + 기본 테넌트. 로컬 개발 편의.
 *
 * 아직 보류(타깃 시장 확정 후): IdP 선택, RBAC 역할 정의, RLS 행 수준 격리, 시크릿 볼트.
 */
@Configuration
@EnableWebSecurity
class SecurityConfig {

    @Bean
    fun securityFilterChain(http: HttpSecurity,
                            jwtDecoder: ObjectProvider<JwtDecoder>,
                            props: SecurityProperties): SecurityFilterChain {
        http
            .csrf { it.disable() }          // 상태 비저장 토큰 인증
            .cors(Customizer.withDefaults())
            // form 노드가 mock 게이트웨이 결제창을 iframe 으로 임베드하므로 X-Frame-Options(기본 DENY) 해제(내부망 도구)
            .headers { h -> h.frameOptions { frame -> frame.disable() } }

        if (jwtDecoder.getIfAvailable() != null) {
            // 운영: OIDC 리소스 서버
            http
                .authorizeHttpRequests { auth ->
                    auth
                        .requestMatchers(*PUBLIC_PATHS).permitAll()
                        .anyRequest().authenticated()
                }
                .oauth2ResourceServer { oauth -> oauth.jwt(Customizer.withDefaults()) }
                .addFilterAfter(TenantClaimFilter(props.tenantClaim),
                    BearerTokenAuthenticationFilter::class.java)
            log.info("보안: OIDC JWT 리소스 서버 활성 (테넌트 클레임='{}')", props.tenantClaim)
        } else {
            // 개발: 인증 없음 (issuer-uri 미설정)
            http.authorizeHttpRequests { auth -> auth.anyRequest().permitAll() }
            log.warn("보안: 개발 모드 — 모든 요청 허용(permitAll). 운영 배포 전 "
                + "spring.security.oauth2.resourceserver.jwt.issuer-uri 설정 필수.")
        }
        return http.build()
    }

    @Bean
    fun corsConfigurationSource(): CorsConfigurationSource {
        val config = CorsConfiguration()
        config.allowedOrigins = listOf(
            "http://localhost:5173",
            "http://localhost:3000",
            "http://localhost:18080"
        )
        config.allowedMethods = listOf("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
        config.allowedHeaders = listOf("*")
        config.allowCredentials = true

        val source = UrlBasedCorsConfigurationSource()
        source.registerCorsConfiguration("/api/**", config)
        return source
    }

    companion object {
        private val log = LoggerFactory.getLogger(SecurityConfig::class.java)

        private val PUBLIC_PATHS = arrayOf(
            "/actuator/health/**", "/actuator/info", "/actuator/prometheus",
            "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html",
            // 외부 콜백(결제/인증 노티)은 백엔드가 받지 않는다 — relay.js 가 수신해 SSE 로 브라우저에 전달
            // mock 서빙은 외부 시스템 흉내라 무인증(slug 는 비밀값 아님 — 테스트 도구 전제)
            "/mock/**",
        )
    }
}
