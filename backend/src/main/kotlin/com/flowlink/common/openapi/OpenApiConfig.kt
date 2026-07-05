package com.flowlink.common.openapi

import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.info.Info
import io.swagger.v3.oas.models.info.License
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
class OpenApiConfig {

    @Bean
    fun flowlinkOpenAPI(): OpenAPI =
        OpenAPI().info(
            Info()
                .title("Flowlink API")
                .description("REST API 워크플로 오케스트레이션 플랫폼 — 정의/실행 API")
                .version("v1")
                .license(License().name("Proprietary"))
        )
}
