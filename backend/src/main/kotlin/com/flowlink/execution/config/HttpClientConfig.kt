package com.flowlink.execution.config

import org.springframework.boot.web.client.ClientHttpRequestFactories
import org.springframework.boot.web.client.ClientHttpRequestFactorySettings
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.client.RestClient
import java.time.Duration

/**
 * 워크플로 노드의 아웃바운드 HTTP 호출 전용 RestClient. 연결/읽기 타임아웃을 강제해
 * 느린 외부 API가 워커를 점유하지 못하게 한다.
 */
@Configuration
class HttpClientConfig {

    @Bean(NODE_REST_CLIENT)
    fun nodeRestClient(props: ExecutionProperties): RestClient {
        val settings = ClientHttpRequestFactorySettings.DEFAULTS
            .withConnectTimeout(Duration.ofMillis(props.http.connectTimeoutMs.toLong()))
            .withReadTimeout(Duration.ofMillis(props.http.readTimeoutMs.toLong()))
        val factory = ClientHttpRequestFactories.get(settings)
        return RestClient.builder()
            .requestFactory(factory)
            .build()
    }

    companion object {
        const val NODE_REST_CLIENT = "nodeRestClient"
    }
}
