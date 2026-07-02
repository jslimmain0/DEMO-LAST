package com.flowlink.execution.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.List;

/** flowlink.execution.* 설정 바인딩. 값이 없으면 안전한 기본값으로 채운다. */
@ConfigurationProperties(prefix = "flowlink.execution")
public record ExecutionProperties(
        Http http,
        Ssrf ssrf,
        Capture capture,
        int maxNodesPerRun
) {
    public ExecutionProperties {
        if (http == null) {
            http = new Http(5000, 30000, 5_242_880L);
        }
        if (ssrf == null) {
            ssrf = new Ssrf(true, true, false, List.of("169.254.169.254"), List.of("http", "https"));
        }
        if (capture == null) {
            capture = new Capture(false);
        }
        if (maxNodesPerRun <= 0) {
            maxNodesPerRun = 200;
        }
    }

    /**
     * 실행 로그 캡처 정책(redaction). 기본은 deny-by-default — 요청/응답 본문은 저장하지 않는다.
     * (본문엔 Authorization 헤더·토큰 등 시크릿이 섞일 수 있어 기본 미저장)
     */
    public record Capture(boolean requestResponseBodies) {
    }

    public record Http(int connectTimeoutMs, int readTimeoutMs, long maxResponseBytes) {
        public Http {
            if (connectTimeoutMs <= 0) {
                connectTimeoutMs = 5000;
            }
            if (readTimeoutMs <= 0) {
                readTimeoutMs = 30000;
            }
            if (maxResponseBytes <= 0) {
                maxResponseBytes = 5_242_880L;
            }
        }
    }

    public record Ssrf(
            boolean enabled,
            boolean blockPrivateNetworks,
            boolean allowLoopback,        // 로컬 배포용: true 면 localhost/127.0.0.1/::1 허용(사설망은 여전히 차단)
            List<String> blockedHosts,
            List<String> allowedSchemes
    ) {
        public Ssrf {
            if (blockedHosts == null) {
                blockedHosts = List.of();
            }
            if (allowedSchemes == null || allowedSchemes.isEmpty()) {
                allowedSchemes = List.of("http", "https");
            }
        }
    }
}
