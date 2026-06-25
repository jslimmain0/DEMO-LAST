package com.flowlink.execution.config;

import org.springframework.boot.web.client.ClientHttpRequestFactories;
import org.springframework.boot.web.client.ClientHttpRequestFactorySettings;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.time.Duration;

/**
 * 워크플로 노드의 아웃바운드 HTTP 호출 전용 RestClient. 연결/읽기 타임아웃을 강제해
 * 느린 외부 API가 워커를 점유하지 못하게 한다.
 */
@Configuration
public class HttpClientConfig {

    public static final String NODE_REST_CLIENT = "nodeRestClient";

    @Bean(NODE_REST_CLIENT)
    public RestClient nodeRestClient(ExecutionProperties props) {
        ClientHttpRequestFactorySettings settings = ClientHttpRequestFactorySettings.DEFAULTS
                .withConnectTimeout(Duration.ofMillis(props.http().connectTimeoutMs()))
                .withReadTimeout(Duration.ofMillis(props.http().readTimeoutMs()));
        ClientHttpRequestFactory factory = ClientHttpRequestFactories.get(settings);
        return RestClient.builder()
                .requestFactory(factory)
                .build();
    }
}
