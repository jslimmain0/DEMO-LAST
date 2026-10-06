package com.flowlink.execution.config

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.client.JdkClientHttpRequestFactory
import org.springframework.web.client.RestClient
import java.net.http.HttpClient
import java.time.Duration

/**
 * 워크플로 노드의 아웃바운드 HTTP 호출 전용 RestClient. 연결/읽기 타임아웃을 강제해
 * 느린 외부 API가 워커를 점유하지 못하게 한다.
 *
 * **JDK HttpClient(java.net.http) 기반** — 구 SimpleClientHttpRequestFactory(HttpURLConnection)는
 * 본문 있는 POST 가 401/407 을 받으면 "cannot retry due to server authentication, in streaming mode"
 * 로 소켓 단계에서 예외를 던져, 노드가 상태코드(401)를 못 읽고 지저분한 I/O 에러로 실패했다.
 * JDK HttpClient 는 4xx 를 정상 응답으로 돌려주므로 `{{ httpStatus@노드 }} == 401` 인증 실패 분기가 가능.
 */
@Configuration
class HttpClientConfig {

    @Bean(NODE_REST_CLIENT)
    fun nodeRestClient(props: ExecutionProperties): RestClient {
        val httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(props.http.connectTimeoutMs.toLong()))
            .followRedirects(HttpClient.Redirect.NORMAL) // HttpURLConnection 리다이렉트 추종과 유사(무회귀)
            .build()
        val factory = JdkClientHttpRequestFactory(httpClient)
        factory.setReadTimeout(Duration.ofMillis(props.http.readTimeoutMs.toLong()))
        return RestClient.builder()
            .requestFactory(factory)
            .build()
    }

    companion object {
        const val NODE_REST_CLIENT = "nodeRestClient"
    }
}
