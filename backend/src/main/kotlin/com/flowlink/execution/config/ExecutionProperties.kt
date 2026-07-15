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
    stateSecret: String? = null,
    worker: Worker? = null,
) {
    val http: Http = http ?: Http(5000, 30000, 5_242_880L)
    val ssrf: Ssrf = ssrf ?: Ssrf(true, true, false, listOf("169.254.169.254"), listOf("http", "https"))
    val capture: Capture = capture ?: Capture(false)
    val relay: Relay = relay ?: Relay(null)
    val maxNodesPerRun: Int = if (maxNodesPerRun <= 0) 200 else maxNodesPerRun

    /** suspension run_state 암호화 키 소스(env FLOWLINK_EXECUTION_STATE_SECRET) — 미설정 시 dev 고정키. */
    val stateSecret: String? = if (stateSecret.isNullOrBlank()) null else stateSecret
    val worker: Worker = worker ?: Worker()

    /** 실행 워커 풀(비동기 실행/재개 연속 실행 전용). 큐 초과 제출은 429 로 거절. */
    class Worker(poolSize: Int = 0, queueCapacity: Int = 0) {
        val poolSize: Int = if (poolSize <= 0) 8 else poolSize
        val queueCapacity: Int = if (queueCapacity <= 0) 100 else queueCapacity
    }

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
        /** 명시 설정된 값(env/yml — 없으면 null). 우선순위 판단은 RelayBaseResolver 가 한다. */
        val configured: String? = if (baseUrl.isNullOrBlank()) null else baseUrl.trim().trimEnd('/')
        val baseUrl: String = configured ?: "http://localhost:18080"
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
