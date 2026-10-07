package com.flowlink.demoweb

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

@SpringBootApplication
@ConfigurationPropertiesScan
class PaymentWebApplication

fun main(args: Array<String>) { runApplication<PaymentWebApplication>(*args) }

@ConfigurationProperties("demo-web")
data class WebProperties(val paymentApiBaseUrl: String, val timeoutMs: Int, val tokenKeyBase64: String)
