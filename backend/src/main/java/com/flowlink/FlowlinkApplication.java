package com.flowlink;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Flowlink — REST API 워크플로 오케스트레이션 플랫폼.
 *
 * <p>프로토타입(클라이언트사이드 FlowBuilder)을 Spring Boot 기반 엔터프라이즈 서비스로 고도화하는
 * 백엔드의 진입점. 1단계는 모듈러 모놀리스(단일 배포)로 시작하며, 패키지 경계
 * (core / definition / execution / trigger / security)로 향후 물리 모듈 분리를 대비한다.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class FlowlinkApplication {

    public static void main(String[] args) {
        SpringApplication.run(FlowlinkApplication.class, args);
    }
}
