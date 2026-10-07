package com.flowlink.demo

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

@SpringBootApplication
@ConfigurationPropertiesScan
class DemoPaymentApplication

fun main(args: Array<String>) { runApplication<DemoPaymentApplication>(*args) }

@ConfigurationProperties("demo")
data class DemoProperties(
    val hyundaiHttpBaseUrl: String,
    val shinhanTcpHost: String,
    val shinhanTcpPort: Int,
    val timeoutMs: Int,
    val tokenTtlSec: Long,
    val allowedCallbackHosts: List<String>,
    val paymentPageUrl: String,
)
