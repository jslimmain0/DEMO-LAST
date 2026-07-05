package com.flowlink.execution.config

import org.springframework.boot.context.properties.ConfigurationProperties

/** flowlink.execution.* 설정 바인딩. 값이 없으면 안전한 기본값으로 채운다. */
@ConfigurationProperties(prefix = "flowlink.execution")
class ExecutionProperties(
    http: Http?,
    ssrf: Ssrf?,
    capture: Capture?,
    relay: Relay?,
    maxNodesPerRun: Int = 0,
) {
    val http: Http = http ?: Http(5000, 30000, 5_242_880L)
    val ssrf: Ssrf = ssrf ?: Ssrf(true, true, false, listOf("169.254.169.254"), listOf("http", "https"))
    val capture: Capture = capture ?: Capture(false)
    val relay: Relay = relay ?: Relay(null)
    val maxNodesPerRun: Int = if (maxNodesPerRun <= 0) 200 else maxNodesPerRun

    /**
     * 실행 로그 캡처 정책(redaction). 기본은 deny-by-default — 요청/응답 본문은 저장하지 않는다.
     * (본문엔 Authorization 헤더·토큰 등 시크릿이 섞일 수 있어 기본 미저장)
     */
    data class Capture(val requestResponseBodies: Boolean = false)

    /**
     * wait(콜백 대기) 노드의 콜백 수신 URL 조립용 base — {baseUrl}/relay/{execId}/cb/{nodeId}.
     * 백엔드가 콜백을 직접 받아 재개하므로 relay.js 없이 백엔드+프론트 2프로세스로 동작한다.
     * 외부 게이트웨이가 콜백해야 하면 이 값을 도달 가능한 주소(터널 등)로 override 한다.
     */
    class Relay(baseUrl: String?) {
        val baseUrl: String =
            if (baseUrl.isNullOrBlank()) "http://localhost:18080" else baseUrl.trim().trimEnd('/')
    }

    class Http(
        connectTimeoutMs: Int = 0,
        readTimeoutMs: Int = 0,
        maxResponseBytes: Long = 0,
    ) {
        val connectTimeoutMs: Int = if (connectTimeoutMs <= 0) 5000 else connectTimeoutMs
        val readTimeoutMs: Int = if (readTimeoutMs <= 0) 30000 else readTimeoutMs
        val maxResponseBytes: Long = if (maxResponseBytes <= 0) 5_242_880L else maxResponseBytes
    }

    class Ssrf(
        val enabled: Boolean = false,
        val blockPrivateNetworks: Boolean = false,
        val allowLoopback: Boolean = false,        // 로컬 배포용: true 면 localhost/127.0.0.1/::1 허용(사설망은 여전히 차단)
        blockedHosts: List<String>? = null,
        allowedSchemes: List<String>? = null,
    ) {
        val blockedHosts: List<String> = blockedHosts ?: listOf()
        val allowedSchemes: List<String> =
            if (allowedSchemes.isNullOrEmpty()) listOf("http", "https") else allowedSchemes
    }
}
