package com.flowlink.mcp

import com.fasterxml.jackson.databind.ObjectMapper
import io.modelcontextprotocol.common.McpTransportContext
import io.modelcontextprotocol.json.jackson.JacksonMcpJsonMapper
import io.modelcontextprotocol.server.McpServer
import io.modelcontextprotocol.server.McpStatelessSyncServer
import io.modelcontextprotocol.server.transport.HttpServletStatelessServerTransport
import io.modelcontextprotocol.spec.McpSchema
import jakarta.servlet.FilterChain
import jakarta.servlet.ReadListener
import jakarta.servlet.ServletInputStream
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletRequestWrapper
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.web.servlet.FilterRegistrationBean
import org.springframework.boot.web.servlet.ServletRegistrationBean
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Import
import org.springframework.core.Ordered
import org.springframework.core.env.Environment
import org.springframework.web.filter.OncePerRequestFilter
import java.time.Duration
import java.util.Properties
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.URI

/** Imported only by the central server host; never component-scanned by desktop. */
@Configuration(proxyBeanMethods = false)
@Import(McpOAuthConfiguration::class)
@ConditionalOnProperty(name = ["flowlink.mcp.enabled"], havingValue = "true", matchIfMissing = true)
class McpConfiguration {
    @Bean fun mcpRestClient(mapper: ObjectMapper) = McpRestClient(mapper)

    @Bean fun mcpTransport(mapper: ObjectMapper, environment: Environment): HttpServletStatelessServerTransport = HttpServletStatelessServerTransport.builder()
        .jsonMapper(JacksonMcpJsonMapper(mapper)).messageEndpoint("/mcp")
        .contextExtractor { request -> McpTransportContext.create(mapOf("invocation" to invocation(request, environment.getProperty("server.ssl.enabled", Boolean::class.java, false)))) }.build()

    @Bean(destroyMethod = "close")
    fun mcpServer(transport: HttpServletStatelessServerTransport, mapper: ObjectMapper, rest: McpRestClient): McpStatelessSyncServer {
        val props = Properties().apply { McpConfiguration::class.java.getResourceAsStream("/flowlink-release.properties")?.use { load(it) } }
        return McpServer.sync(transport).jsonMapper(JacksonMcpJsonMapper(mapper))
            .serverInfo("flowlink", props.getProperty("version", "unknown"))
            .instructions("FlowLink 중앙 MCP. target은 개인/팀 저장 공간, executionAgent는 요청 출발지입니다. 개인 작업은 로그인한 온라인 Windows 앱이 필요합니다. UNKNOWN 결과를 자동 재실행하지 마세요.")
            .capabilities(McpSchema.ServerCapabilities.builder().tools(false).build())
            .requestTimeout(Duration.ofMinutes(20)).tools(McpTools(mapper, rest).specifications()).build()
    }

    @Bean fun mcpServlet(transport: HttpServletStatelessServerTransport, server: McpStatelessSyncServer) = ServletRegistrationBean(transport, "/mcp").apply {
        setName("flowlinkMcp"); setAsyncSupported(true); setLoadOnStartup(1)
    }

    @Bean fun mcpGate(credentials: McpCredentials, mapper: ObjectMapper, environment: Environment): FilterRegistrationBean<OncePerRequestFilter> {
        val filter = object : OncePerRequestFilter() {
            override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
                val origin = request.getHeader("Origin")
                val publicUrl = environment.getProperty("FLOWLINK_PUBLIC_URL")?.takeIf(String::isNotBlank)
                    ?: environment.getProperty("flowlink.runtime.public-url")?.takeIf(String::isNotBlank)
                val explicitOrigins = environment.getProperty("flowlink.mcp.allowed-origins").orEmpty().split(',').map(String::trim).filter(String::isNotEmpty)
                val publicOrigin = publicUrl?.let { runCatching { URI(it).let { uri -> "${uri.scheme}://${uri.rawAuthority}" } }.getOrNull() }
                val allowed = (explicitOrigins + listOfNotNull(publicOrigin) + if (publicUrl == null) listOf("http://127.0.0.1:${request.localPort}", "http://localhost:${request.localPort}") else emptyList()).mapNotNull(::normalizedOrigin).toSet()
                if (origin != null && (normalizedOrigin(origin) == null || normalizedOrigin(origin) !in allowed)) {
                    response.sendError(403, "허용되지 않은 MCP 요청 출처입니다"); return
                }
                if (origin != null) {
                    response.setHeader("Access-Control-Allow-Origin", origin)
                    response.setHeader("Vary", "Origin")
                    response.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
                    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id")
                    response.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate")
                }
                if (request.method == "OPTIONS") { response.status = 204; return }
                val registration = request.requestURI.removePrefix(request.contextPath) == "/register"
                val maxBytes = if (registration) MAX_REGISTRATION_BYTES else MAX_REQUEST_BYTES
                if (request.contentLengthLong > maxBytes) { response.sendError(413, "요청 본문 크기 제한을 초과했습니다"); return }
                if (registration) { chain.doFilter(limitedRequest(request, maxBytes), response); return }
                try {
                    // Broad app/GitHub tokens and guest access never authorize MCP.
                    // The host checks revocation/account status, then supplies an internal-only credential.
                    request.setAttribute(MANAGEMENT_AUTHORIZATION, credentials.managementAuthorization(request.getHeader("Authorization")))
                } catch (ex: org.springframework.security.oauth2.jwt.JwtException) {
                    response.status = 401
                    if (response.status == 401) {
                        val resourceOrigin = publicUrl?.trim()?.trimEnd('/') ?: "${request.scheme}://${request.serverName}${if (request.serverPort in setOf(80, 443)) "" else ":${request.serverPort}"}${request.contextPath}"
                        response.setHeader("WWW-Authenticate", "Bearer resource_metadata=\"$resourceOrigin/.well-known/oauth-protected-resource\"")
                    }
                    response.contentType = "application/json;charset=UTF-8"
                    mapper.writeValue(response.outputStream, mapOf("error" to if (response.status == 401) "FlowLink 서버 로그인이 필요합니다" else "인증 상태를 확인하지 못했습니다"))
                    return
                } catch (ex: org.springframework.web.server.ResponseStatusException) {
                    response.status = ex.statusCode.value()
                    response.contentType = "application/json;charset=UTF-8"
                    mapper.writeValue(response.outputStream, mapOf("error" to "MCP 연결 권한이 없습니다"))
                    return
                } catch (ex: Exception) {
                    if (response.isCommitted) throw ex
                    response.status = 503; response.contentType = "application/json;charset=UTF-8"
                    mapper.writeValue(response.outputStream, mapOf("error" to "FlowLink 인증 상태를 확인하지 못했습니다"))
                    return
                }
                chain.doFilter(limitedRequest(request, maxBytes), response)
            }
        }
        return FilterRegistrationBean<OncePerRequestFilter>(filter).apply { setName("flowlinkMcpAuthentication"); addUrlPatterns("/mcp", "/register"); order = Ordered.HIGHEST_PRECEDENCE + 20 }
    }

    companion object {
        const val MAX_REQUEST_BYTES = 8L * 1024 * 1024
        const val MAX_REGISTRATION_BYTES = 64L * 1024
        private const val MANAGEMENT_AUTHORIZATION = "flowlink.mcp.managementAuthorization"

        fun normalizedOrigin(raw: String): String? = runCatching {
            val uri = URI(raw)
            require(uri.scheme in setOf("http", "https") && uri.host != null && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && uri.rawPath in setOf("", "/"))
            val port = if (uri.port == -1) (if (uri.scheme == "https") 443 else 80) else uri.port
            "${uri.scheme.lowercase()}://${uri.host.lowercase()}:$port"
        }.getOrNull()

        private fun limitedRequest(request: HttpServletRequest, maxBytes: Long): HttpServletRequest = object : HttpServletRequestWrapper(request) {
            private val bounded = object : ServletInputStream() {
                private val input = request.inputStream
                private var count = 0L
                private fun checked(size: Int): Int { if (size > 0) count += size; if (count > maxBytes) throw IOException("요청 본문 크기 제한을 초과했습니다"); return size }
                override fun read(): Int = input.read().also { if (it >= 0) checked(1) }
                override fun read(bytes: ByteArray, offset: Int, length: Int): Int = checked(input.read(bytes, offset, length))
                override fun isFinished(): Boolean = input.isFinished
                override fun isReady(): Boolean = input.isReady
                override fun setReadListener(listener: ReadListener) = input.setReadListener(listener)
            }
            override fun getInputStream(): ServletInputStream = bounded
            override fun getReader(): BufferedReader = BufferedReader(InputStreamReader(bounded, Charsets.UTF_8))
        }

        fun invocation(request: HttpServletRequest, connectorSecure: Boolean = false): McpInvocation {
            val authorization = request.getAttribute(MANAGEMENT_AUTHORIZATION) as? String
            // ForwardedHeaderFilter may report HTTPS while the actual Tomcat connector is plain HTTP.
            // Only connector configuration decides the internal scheme; client headers never do.
            val scheme = if (connectorSecure) "https" else "http"
            return McpInvocation("$scheme://127.0.0.1:${request.localPort}${request.contextPath}", authorization)
        }
    }
}
