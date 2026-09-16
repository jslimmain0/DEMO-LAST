package com.flowlink.security

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.annotation.Order
import org.springframework.security.config.Customizer
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter
import org.springframework.security.web.SecurityFilterChain
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.CorsConfigurationSource
import org.springframework.web.cors.UrlBasedCorsConfigurationSource

/**
 * 보안 구성.
 *
 * **동작 모드**는 `flowlink.auth.github-enabled` 설정 유무로 결정된다:
 * - **GitHub 게스트 모드(flowlink.auth.github-enabled=true)**: 앱은 로그인 없이 개방(게스트 전권),
 *   assistant API(AI, 로그인 사용자 전용)만 로그인 필수. 로그인=AI 사용+신원 표시 게이트.
 *   Bearer 를 실은 로그인 사용자는 자체 JWT 리소스 서버가 신원 인식, [TenantClaimFilter] 가
 *   테넌트 클레임을 [com.flowlink.common.tenant.TenantContext] 에 주입.
 * - **개발(github-enabled 미설정)**: 모든 요청 허용(permitAll) + 기본 테넌트. 로컬 개발 편의.
 *
 * 외부 시스템이 직접 때리는 경로(mock 게이트웨이·wait 콜백·웹훅)는 [externalFilterChain] 이 먼저 가져간다.
 */
@Configuration
@EnableWebSecurity
class SecurityConfig {

    /**
     * 외부 시스템 전용 무인증 체인 — Mock 게이트웨이(`/mock/` 이하) · wait 콜백(`/relay/` 이하) · 웹훅 트리거(`/hooks/` 이하).
     *
     * 이 경로들은 **우리 앱이 아닌 상대 시스템의 요청**이라 `Authorization` 헤더에 자기네 토큰(대상 시스템 흉내용
     * Bearer/Basic, 결제 게이트웨이 노티의 서명 헤더 등)이 실려 온다. 메인 체인에 두면 리소스 서버의
     * BearerTokenAuthenticationFilter 가 그걸 앱 JWT 로 검증하려다 **permitAll 이어도 401** 을 내버린다
     * (= 목이 안 뜨고 콜백이 유실). 전용 체인은 리소스 서버 필터 자체가 없어 헤더를 그냥 데이터로 흘려보낸다.
     *
     * 인증이 없어도 되는 근거: slug/execId/웹훅 토큰이 곧 접근 열쇠이고, 애초에 무인증 테스트 도구·콜백 수신구다.
     */
    @Bean
    @Order(1)
    fun externalFilterChain(http: HttpSecurity): SecurityFilterChain {
        http
            .securityMatcher("/mock/**", "/relay/**", "/hooks/**")
            .csrf { it.disable() }
            .cors(Customizer.withDefaults())
            // 결제창 등 mock HTML 을 form 노드가 iframe 으로 띄운다
            .headers { h -> h.frameOptions { frame -> frame.disable() } }
            .requestCache { it.disable() }
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .authorizeHttpRequests { auth -> auth.anyRequest().permitAll() }
        return http.build()
    }

    @Bean
    @Order(2)
    fun securityFilterChain(http: HttpSecurity,
                            jwtDecoder: ObjectProvider<JwtDecoder>,
                            authProps: AuthProperties): SecurityFilterChain {
        http
            .csrf { it.disable() }          // 상태 비저장 토큰 인증
            .cors(Customizer.withDefaults())
            // form 노드가 mock 게이트웨이 결제창을 iframe 으로 임베드하므로 X-Frame-Options(기본 DENY) 해제(내부망 도구)
            .headers { h -> h.frameOptions { frame -> frame.disable() } }

        if (jwtDecoder.getIfAvailable() != null && authProps.githubEnabled) {
            // github 게스트 모드(2026-07-28): 앱은 로그인 없이 개방(게스트 전권 — 사용자 결정, 사내망 전제),
            // AI(/api/v1/assistant/**)만 로그인 필수 — Copilot 이 사용자 GitHub 토큰을 쓰는 본질적 게이트.
            // Bearer 를 실은 로그인 사용자는 리소스 서버가 계속 신원 인식(triggeredBy·Copilot 연결·presence 이름).
            // 무효/만료 Bearer 는 permitAll 경로에서도 401(리소스 서버 규약) → 프론트가 토큰 폐기 후 게스트 재부트.
            http
                .authorizeHttpRequests { auth ->
                    auth
                        .requestMatchers("/api/v1/assistant/**").authenticated()
                        .anyRequest().permitAll()
                }
                .oauth2ResourceServer { oauth ->
                    oauth.jwt { jwt -> jwt.jwtAuthenticationConverter(JwtRoleConverter()) }
                }
                .addFilterAfter(TenantClaimFilter(),
                    BearerTokenAuthenticationFilter::class.java)
            log.info("보안: GitHub 게스트 모드 — 앱 개방(로그인 선택), /api/v1/assistant/** 만 로그인 필수")
        } else {
            // 개발: 인증 없음 (github-enabled 미설정)
            http.authorizeHttpRequests { auth -> auth.anyRequest().permitAll() }
            log.warn("보안: 개발 모드 — 모든 요청 허용(permitAll). 운영 배포 전 FLOWLINK_AUTH_GITHUB_ENABLED=true 설정 필수.")
        }
        return http.build()
    }

    @Bean
    fun corsConfigurationSource(): CorsConfigurationSource {
        val config = CorsConfiguration()
        config.allowedOriginPatterns = listOf("*")
        config.allowedMethods = listOf("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
        config.allowedHeaders = listOf("*")
        config.allowCredentials = true

        val source = UrlBasedCorsConfigurationSource()
        source.registerCorsConfiguration("/api/**", config)
        return source
    }

    companion object {
        private val log = LoggerFactory.getLogger(SecurityConfig::class.java)
    }
}
