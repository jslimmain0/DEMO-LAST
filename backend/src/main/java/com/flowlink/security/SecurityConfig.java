package com.flowlink.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.List;

/**
 * 보안 구성 (IdP 비종속).
 *
 * <p><b>동작 모드</b>는 {@code spring.security.oauth2.resourceserver.jwt.issuer-uri} 설정 유무로 자동 결정된다:
 * <ul>
 *   <li><b>운영(issuer-uri 설정 시)</b>: OIDC JWT 리소스 서버로 동작 — {@code /api/**} 는 인증 필수,
 *       {@link TenantClaimFilter} 가 JWT 테넌트 클레임을 {@link com.flowlink.common.tenant.TenantContext} 에 주입.
 *       어떤 OIDC IdP(Auth0/Cognito/Entra/Keycloak)와도 호환.</li>
 *   <li><b>개발(issuer-uri 미설정)</b>: 모든 요청 허용(permitAll) + 기본 테넌트. 로컬 개발 편의.</li>
 * </ul>
 *
 * <p>아직 보류(타깃 시장 확정 후): IdP 선택, RBAC 역할 정의, RLS 행 수준 격리, 시크릿 볼트.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    private static final Logger log = LoggerFactory.getLogger(SecurityConfig.class);

    private static final String[] PUBLIC_PATHS = {
            "/actuator/health/**", "/actuator/info", "/actuator/prometheus",
            "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html",
            // 외부 콜백(결제/인증 노티)은 백엔드가 받지 않는다 — relay.js 가 수신해 SSE 로 브라우저에 전달
            // mock 서빙은 외부 시스템 흉내라 무인증(slug 는 비밀값 아님 — 테스트 도구 전제)
            "/mock/**",
    };

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http,
                                                   ObjectProvider<JwtDecoder> jwtDecoder,
                                                   SecurityProperties props) throws Exception {
        http
                .csrf(csrf -> csrf.disable())          // 상태 비저장 토큰 인증
                .cors(Customizer.withDefaults());

        if (jwtDecoder.getIfAvailable() != null) {
            // 운영: OIDC 리소스 서버
            http
                    .authorizeHttpRequests(auth -> auth
                            .requestMatchers(PUBLIC_PATHS).permitAll()
                            .anyRequest().authenticated())
                    .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()))
                    .addFilterAfter(new TenantClaimFilter(props.tenantClaim()),
                            BearerTokenAuthenticationFilter.class);
            log.info("보안: OIDC JWT 리소스 서버 활성 (테넌트 클레임='{}')", props.tenantClaim());
        } else {
            // 개발: 인증 없음 (issuer-uri 미설정)
            http.authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
            log.warn("보안: 개발 모드 — 모든 요청 허용(permitAll). 운영 배포 전 "
                    + "spring.security.oauth2.resourceserver.jwt.issuer-uri 설정 필수.");
        }
        return http.build();
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(List.of(
                "http://localhost:5173",
                "http://localhost:3000",
                "http://localhost:18080"
        ));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("*"));
        config.setAllowCredentials(true);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        return source;
    }
}
