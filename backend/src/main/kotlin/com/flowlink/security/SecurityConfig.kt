package com.flowlink.security

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpMethod
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
            // 운영: OIDC 리소스 서버 + URL RBAC (admin/editor/viewer + 전역 platform-admin)
            http
                .authorizeHttpRequests { auth ->
                    auth
                        .requestMatchers(*PUBLIC_PATHS).permitAll()
                        // 프론트가 인증 모드를 발견하는 부트스트랩 + GitHub 로그인 엔드포인트(로그인 전이라 무인증)
                        .requestMatchers("/api/v1/auth/config", "/api/v1/auth/github/**").permitAll()
                        // 플러그인 = 임의 JAR 실행 + 전역 레지스트리 → 팀 admin 도 불가, 전역 롤만.
                        // ⚠ 메서드 무관 + GET 조회 규칙보다 먼저 — 목록 조회(GET)도 platform-admin 만
                        // (매처는 선언 순서 우선매치라, 아래 GET /api/v1/** 보다 반드시 위에 있어야 한다)
                        .requestMatchers("/api/v1/plugins/**").hasRole("platform-admin")
                        // 설정 저장(콜백 수신 주소 등)은 팀 admin (PUT 은 GET 블랭킷에 안 걸리지만 명시 우선)
                        .requestMatchers(HttpMethod.PUT, "/api/v1/settings/**").hasRole("admin")
                        // 알림 웹훅 URL(Slack/Teams)은 그 자체가 채널 쓰기 자격증명 → GET 도 admin 만(viewer 노출 방지)
                        .requestMatchers(HttpMethod.GET, "/api/v1/settings/notify").hasRole("admin")
                        // 트리거는 webhookToken(무인증 /hooks 실행 경로의 유일한 비밀)을 반환하므로 GET 포함 editor 이상
                        // (GET 블랭킷보다 먼저 — viewer 가 토큰을 조회하지 못하게)
                        .requestMatchers("/api/v1/flows/*/triggers/**").hasAnyRole("editor", "admin")
                        // 시크릿 볼트는 write-only(값 미노출)지만 이름 목록도 editor 이상으로 제한
                        .requestMatchers("/api/v1/secrets/**").hasAnyRole("editor", "admin")
                        // 팀 지침은 전 팀원 프롬프트에 주입되는 스토어드 텍스트 → admin 만(프롬프트 인젝션 방지)
                        .requestMatchers("/api/v1/assistant/instructions").hasRole("admin")
                        // AI 어시스턴트(플로우 생성/수정·스킬)는 editor 이상. GET /config 도 포함(가용상태만이지만 쓰기 도구)
                        .requestMatchers("/api/v1/assistant/**").hasAnyRole("editor", "admin")
                        // 조회는 viewer 포함 인증만 (위의 구체 규칙에서 안 걸린 나머지 GET)
                        .requestMatchers(HttpMethod.GET, "/api/v1/**").authenticated()
                        // 나머지 쓰기(플로우/폴더/mock CRUD·실행·재개)는 editor 이상
                        .requestMatchers("/api/v1/**").hasAnyRole("editor", "admin")
                        // 동봉 SPA 셸 — 로그인 전에 index.html/assets 가 로드돼야 SSO 리다이렉트가
                        // 시작된다. 화면 라우트(GET, SPA fallback=index.html)와 정적 번들만 명시 허용
                        // (데이터는 전부 /api 게이트 뒤 — 셸 자체엔 비밀 없음).
                        .requestMatchers(HttpMethod.GET,
                            "/", "/index.html", "/assets/**", "/favicon.svg", "/auth/callback",
                            "/flows", "/flows/*", "/executions", "/mocks", "/mocks/*").permitAll()
                        .anyRequest().authenticated()
                }
                .oauth2ResourceServer { oauth ->
                    oauth.jwt { jwt -> jwt.jwtAuthenticationConverter(JwtRoleConverter()) }
                }
                .addFilterAfter(TenantClaimFilter(props.tenantClaim),
                    BearerTokenAuthenticationFilter::class.java)
            log.info("보안: OIDC JWT 리소스 서버 + RBAC 활성 (테넌트 클레임='{}')", props.tenantClaim)
        } else {
            // 개발: 인증 없음 (issuer-uri 미설정)
            http.authorizeHttpRequests { auth -> auth.anyRequest().permitAll() }
            log.warn("보안: 개발 모드 — 모든 요청 허용(permitAll). 운영 배포 전 "
                + "spring.security.oauth2.resourceserver.jwt.issuer-uri 설정 필수.")
        }
        return http.build()
    }

    @Bean
    fun corsConfigurationSource(props: SecurityProperties): CorsConfigurationSource {
        val config = CorsConfiguration()
        config.allowedOrigins = props.corsOrigins
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
            // wait(콜백 대기) 노드의 콜백을 백엔드가 직접 받아 재개한다(RelayController). 외부 시스템(게이트웨이/노티)이
            // 부르는 무인증 엔드포인트 — execId 는 추측 불가한 UUID(테스트 도구 전제, 사내망).
            "/relay/**",
            // mock 서빙은 외부 시스템 흉내라 무인증(slug 는 비밀값 아님 — 테스트 도구 전제)
            "/mock/**",
            // 인바운드 웹훅 — 외부 시스템이 부르는 무인증 실행 트리거(token 은 추측 불가한 비밀값)
            "/hooks/**",
            // presence WebSocket 핸드셰이크 — 브라우저 WebSocket 은 Authorization 헤더를 못 실어
            // 인터셉터가 쿼리 token 으로 자체 검증한다(PresenceHandshakeInterceptor)
            "/ws/**",
        )
    }
}
