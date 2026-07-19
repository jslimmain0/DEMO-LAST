package com.flowlink

import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Flowlink — REST API 워크플로 오케스트레이션 플랫폼.
 *
 * 프로토타입(클라이언트사이드 FlowBuilder)을 Spring Boot 기반 엔터프라이즈 서비스로 고도화하는
 * 백엔드의 진입점. 1단계는 모듈러 모놀리스(단일 배포)로 시작하며, 패키지 경계
 * (core / definition / execution / trigger / security)로 향후 물리 모듈 분리를 대비한다.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
class FlowlinkApplication

private val log = LoggerFactory.getLogger(FlowlinkApplication::class.java)

fun main(args: Array<String>) {
    maybeDisableTlsVerification()
    runApplication<FlowlinkApplication>(*args)
}

/**
 * `FLOWLINK_TLS_INSECURE=true` 면 아웃바운드 TLS 인증서·호스트명 검증을 전부 끈다(모든 인증서 신뢰).
 *
 * ⚠ MITM 에 노출되는 보안 다운그레이드 — **신뢰 가능한 사내망/프록시 뒤 내부 도구 전제**에서만 사용.
 * 정석 해법은 신뢰 저장소에 사내 CA 를 추가하는 것(Windows 는 scripts/start.ps1 의 WINDOWS-ROOT).
 * HttpClient/RestClient 빈이 만들어지기 전에 기본 SSLContext 를 교체해야 하므로 main() 최상단에서 처리한다.
 */
private fun maybeDisableTlsVerification() {
    val v = System.getenv("FLOWLINK_TLS_INSECURE")?.trim()?.lowercase()
    if (v != "true" && v != "1" && v != "yes") return
    try {
        val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, trustAll, SecureRandom())
        SSLContext.setDefault(ctx) // java.net.http.HttpClient · Spring RestClient · HttpsURLConnection 공용 기본
        HttpsURLConnection.setDefaultSSLSocketFactory(ctx.socketFactory)
        HttpsURLConnection.setDefaultHostnameVerifier(HostnameVerifier { _, _ -> true })
        System.setProperty("jdk.internal.httpclient.disableHostnameVerification", "true") // java.net.http 호스트명 검증 off
        log.warn(
            "⚠⚠ FLOWLINK_TLS_INSECURE — 아웃바운드 TLS 인증서/호스트명 검증을 모두 비활성화했습니다(모든 인증서 신뢰). " +
                "MITM 에 취약하니 신뢰 가능한 사내망 전용으로만 쓰세요. 정석은 신뢰 저장소에 CA 추가(WINDOWS-ROOT/커스텀 truststore).",
        )
    } catch (e: Exception) {
        log.error("TLS 검증 비활성화 설정 실패: {}", e.message)
    }
}
