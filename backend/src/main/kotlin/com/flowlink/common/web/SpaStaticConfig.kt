package com.flowlink.common.web

import org.springframework.context.annotation.Configuration
import org.springframework.core.io.ClassPathResource
import org.springframework.core.io.Resource
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer
import org.springframework.web.servlet.resource.PathResourceResolver

/**
 * 프론트엔드(dist) 동봉 서빙 — 단일 jar 배포용(내장 톰캣이 프론트+백엔드를 함께 서빙).
 *
 * 빌드 시 `frontend/dist` 가 classpath:/static/ 으로 복사되고(copyFrontend gradle 태스크),
 * BrowserRouter 딥링크(/flows/{id} 새로고침 등)는 index.html 로 fallback 한다.
 * - 컨트롤러(@RequestMapping)가 항상 우선이라 /api·/mock·/relay 동작은 영향 없음
 * - API 성 경로는 fallback 제외 — 없는 API 가 HTML 을 받지 않게
 * - static 에 index.html 이 없으면(프론트 미동봉 dev 빌드) 기존 404 그대로(무회귀)
 */
@Configuration
class SpaStaticConfig : WebMvcConfigurer {

    override fun addResourceHandlers(registry: ResourceHandlerRegistry) {
        registry.addResourceHandler("/**")
            .addResourceLocations("classpath:/static/")
            .resourceChain(true)
            .addResolver(object : PathResourceResolver() {
                override fun getResource(resourcePath: String, location: Resource): Resource? {
                    val real = super.getResource(resourcePath, location)
                    if (real != null) {
                        return real
                    }
                    // SPA fallback — API 성 경로는 제외
                    for (p in NO_FALLBACK_PREFIXES) {
                        if (resourcePath.startsWith(p)) {
                            return null
                        }
                    }
                    val index = ClassPathResource("static/index.html")
                    return if (index.exists()) index else null
                }
            })
    }

    companion object {
        private val NO_FALLBACK_PREFIXES = listOf(
            "api/", "mock/", "relay/", "hooks/", "actuator/", "swagger-ui", "v3/", "h2-console", "ws/",
        )
    }
}
