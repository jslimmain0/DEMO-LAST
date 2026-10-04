package com.flowlink.execution.config

import org.springframework.boot.context.properties.ConfigurationProperties

/** flowlink.execution.* 설정 바인딩. 값이 없으면 안전한 기본값으로 채운다. */
@ConfigurationProperties(prefix = "flowlink.execution")
class ExecutionProperties(
    http: Http?,
    maxNodesPerRun: Int = 0,
    worker: Worker? = null,
) {
    val http: Http = http ?: Http(5000, 30000, 5_242_880L)
    val maxNodesPerRun: Int = if (maxNodesPerRun <= 0) 200 else maxNodesPerRun
    val worker: Worker = worker ?: Worker()

    /** 실행 워커 풀(비동기 실행/재개 연속 실행 전용). 큐 초과 제출은 429 로 거절. */
    class Worker(poolSize: Int = 0, queueCapacity: Int = 0) {
        val poolSize: Int = if (poolSize <= 0) 8 else poolSize
        val queueCapacity: Int = if (queueCapacity <= 0) 100 else queueCapacity
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
}
