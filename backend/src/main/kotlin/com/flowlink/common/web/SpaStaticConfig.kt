package com.flowlink.common.web

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Configuration
import org.springframework.core.io.ByteArrayResource
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
 * - **context path**(`server.servlet.context-path`, env `FLOWLINK_CONTEXT_PATH=/flowlink`): index.html 의 `<base href="/">` 를
 *   `<base href="/flowlink/">` 로 바꿔 서빙한다 — 프론트는 상대 경로 빌드(Vite `base: './'`)라 자산·라우터·API·WebSocket 이 전부 이 값을 따라간다.
 */
@Configuration
class SpaStaticConfig(
    @Value("\${server.servlet.context-path:}") private val contextPath: String,
) : WebMvcConfigurer {

    private val log = LoggerFactory.getLogger(SpaStaticConfig::class.java)

    // index.html 은 1회 변환 후 캐시(내용은 jar 에 고정)
    private val indexResource: Resource? by lazy { buildIndex() }

    override fun addResourceHandlers(registry: ResourceHandlerRegistry) {
        registry.addResourceHandler("/**")
            .addResourceLocations("classpath:/static/")
            .resourceChain(true)
            .addResolver(object : PathResourceResolver() {
                override fun getResource(resourcePath: String, location: Resource): Resource? {
                    val real = super.getResource(resourcePath, location)
                    if (real != null) {
                        // 루트(/) 요청은 WelcomePage 가 index.html 로 forward — 그때도 <base href> 를 바꾼 사본을 준다
                        return if (resourcePath == "index.html") indexResource ?: real else real
                    }
                    // SPA fallback — API 성 경로는 제외
                    for (p in NO_FALLBACK_PREFIXES) {
                        if (resourcePath.startsWith(p)) {
                            return null
                        }
                    }
                    return indexResource
                }
            })
    }

    private fun buildIndex(): Resource? {
        val index = ClassPathResource("static/index.html")
        if (!index.exists()) return null
        val html = index.inputStream.use { String(it.readAllBytes(), Charsets.UTF_8) }
        val base = if (contextPath.isBlank()) "/" else contextPath.trimEnd('/') + "/"
        val rewritten = rewriteBase(html, base)
        if (rewritten === html && base != "/") log.warn("index.html 에 <base href> 가 없어 context path({})를 반영하지 못했습니다 — 프론트 빌드 확인", base)
        if (base != "/") log.info("SPA index.html <base href=\"{}\"> (context path)", base)
        val bytes = rewritten.toByteArray(Charsets.UTF_8)
        return object : ByteArrayResource(bytes) {
            override fun getFilename(): String = "index.html" // 콘텐츠 타입(text/html) 판정용
            override fun lastModified(): Long = index.lastModified()
        }
    }

    companion object {
        private val BASE_TAG = Regex("<base\\s+href=\"[^\"]*\"\\s*/?>", RegexOption.IGNORE_CASE)
        private val NO_FALLBACK_PREFIXES = listOf(
            "api/", "mock/", "relay/", "hooks/", "actuator/", "h2-console", "ws/",
        )

        /** index.html 의 `<base href="…">` 를 주어진 base 로 교체(순수). 태그가 없으면 원문 그대로. */
        @JvmStatic
        fun rewriteBase(html: String, base: String): String =
            if (BASE_TAG.containsMatchIn(html)) BASE_TAG.replaceFirst(html, "<base href=\"$base\" />") else html
    }
}
