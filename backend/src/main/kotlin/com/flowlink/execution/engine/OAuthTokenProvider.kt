package com.flowlink.execution.engine

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.core.graph.HttpAuth
import com.flowlink.execution.config.HttpClientConfig
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpMethod
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

/**
 * OAuth2 client_credentials(M2M) 토큰 취득·캐시. HTTP 노드 실행 직전 [bearer] 로 access_token 을 얻어
 * `Authorization: Bearer` 로 주입한다. 토큰 URL 은 SsrfGuard 로 검증. 캐시는 (tokenUrl,clientId,scope,secret) 별
 * 만료 30초 스큐 전까지 재사용(중복 토큰 발급 방지).
 */
@Component
class OAuthTokenProvider(
    @Qualifier(HttpClientConfig.NODE_REST_CLIENT) private val restClient: RestClient,
    private val ssrfGuard: SsrfGuard,
    private val tokens: TokenResolver,
    private val json: JsonService,
) {
    private data class Cached(val token: String, val expiresAt: Instant)

    private val cache = ConcurrentHashMap<String, Cached>()

    /** access_token 문자열. 실패 시 BadRequestException(메시지는 호출부가 노드 실패로 변환). */
    fun bearer(auth: HttpAuth, ctx: ExecutionContext): String {
        val tokenUrl = tokens.resolveTokens(auth.tokenUrl ?: "", ctx).trim()
        val clientId = tokens.resolveTokens(auth.clientId ?: "", ctx).trim()
        val clientSecret = tokens.resolveTokens(auth.clientSecret ?: "", ctx)
        val scope = tokens.resolveTokens(auth.scope ?: "", ctx).trim()
        if (tokenUrl.isBlank()) throw BadRequestException("OAuth 토큰 URL 이 비어 있습니다.")
        if (clientId.isBlank()) throw BadRequestException("OAuth client_id 가 비어 있습니다.")

        val key = "$tokenUrl|$clientId|$scope|${clientSecret.hashCode()}"
        val now = Instant.now()
        cache[key]?.let { if (it.expiresAt.isAfter(now.plusSeconds(5))) return it.token }

        val uri = try { URI.create(tokenUrl) } catch (e: Exception) { throw BadRequestException("OAuth 토큰 URL 이 올바르지 않습니다.") }
        try { ssrfGuard.check(uri) } catch (e: Exception) { throw BadRequestException("OAuth 토큰 URL 차단됨(SSRF): ${e.message}") }

        val basic = "basic".equals(auth.clientAuth, ignoreCase = true)
        val form = buildString {
            append("grant_type=client_credentials")
            if (scope.isNotBlank()) append("&scope=").append(enc(scope))
            if (!basic) {
                append("&client_id=").append(enc(clientId))
                if (clientSecret.isNotEmpty()) append("&client_secret=").append(enc(clientSecret))
            }
        }
        val bodyText: String = try {
            var spec = restClient.method(HttpMethod.POST).uri(uri)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("Accept", "application/json")
            if (basic) {
                val cred = Base64.getEncoder().encodeToString("$clientId:$clientSecret".toByteArray(StandardCharsets.UTF_8))
                spec = spec.header("Authorization", "Basic $cred")
            }
            spec.body(form.toByteArray(StandardCharsets.UTF_8))
                .exchange { _, response ->
                    val body = response.body.readBytes().toString(StandardCharsets.UTF_8)
                    if (response.statusCode.isError) throw BadRequestException("토큰 발급 실패 ${response.statusCode.value()}: ${body.take(200)}")
                    body
                } ?: ""
        } catch (e: BadRequestException) {
            throw e
        } catch (e: Exception) {
            throw BadRequestException("OAuth 토큰 요청 실패: ${e.message}")
        }

        val root = try { json.readTree(bodyText) } catch (e: Exception) { throw BadRequestException("OAuth 토큰 응답 파싱 실패") }
        val token = root.path("access_token").asText(null)
            ?: throw BadRequestException("OAuth 응답에 access_token 이 없습니다.")
        if (token.isBlank()) throw BadRequestException("OAuth access_token 이 비어 있습니다.")
        val ttl = when {
            auth.cacheSeconds != null && auth.cacheSeconds > 0 -> auth.cacheSeconds.toLong()
            root.path("expires_in").isNumber -> root.path("expires_in").asLong()
            else -> 3600L
        }
        cache[key] = Cached(token, now.plusSeconds(ttl).minusSeconds(30))
        return token
    }

    private fun enc(s: String): String = URLEncoder.encode(s, StandardCharsets.UTF_8)
}
