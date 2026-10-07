package com.flowlink.demoweb

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.core.io.ClassPathResource
import org.springframework.http.ResponseEntity
import org.springframework.stereotype.Component
import org.springframework.web.ErrorResponse
import org.springframework.web.bind.annotation.*
import org.springframework.web.filter.OncePerRequestFilter
import org.springframework.web.util.HtmlUtils
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLDecoder
import java.util.Base64
import java.util.Locale

class WebFailure(val status: Int, val code: String, message: String) : RuntimeException(message)
private fun fail(status: Int, code: String, message: String): Nothing = throw WebFailure(status, code, message)

@RestController
class PaymentWebController(private val config: WebProperties, private val json: ObjectMapper) {
    private val key = Base64.getDecoder().decode(config.tokenKeyBase64)
    private val template = ClassPathResource("templates/pay.html").getContentAsString(Charsets.UTF_8)
    init {
        val url = URI(config.paymentApiBaseUrl)
        require(url.scheme in listOf("http", "https") && url.host != null && url.userInfo == null && url.query == null && url.fragment == null)
        require(config.timeoutMs in 50..60000 && key.size == 32 && Base64.getEncoder().encodeToString(key) == config.tokenKeyBase64)
    }
    @GetMapping("/health") fun health() = mapOf("status" to "UP", "application" to "demo-payment-web")
    @GetMapping("/", produces = ["text/html;charset=UTF-8"])
    fun home() = """<!doctype html><html lang="ko"><meta charset="utf-8"><title>발표용 결제 화면 서버</title><h1>결제 화면 서버</h1><p>가맹점이 암호화한 토큰을 POST /pay로 전달하면 복호화 후 결제 화면을 엽니다.</p><a href="/health">프론트 서버 상태 확인</a></html>"""

    @PostMapping("/pay")
    fun open(request: HttpServletRequest, response: HttpServletResponse): ResponseEntity<*> {
        val encrypted = body(request)["encryptedToken"]?.takeIf { it.isTextual }?.textValue()
            ?: fail(400, "INVALID_ENCRYPTED_TOKEN", "암호화된 토큰을 전달하세요.")
        val token = try { TokenCrypto.decrypt(encrypted, key) }
        catch (_: Exception) { fail(400, "INVALID_ENCRYPTED_TOKEN", "암호화된 토큰을 복호화할 수 없습니다. 키와 암호문 형식을 확인하세요.") }
        // 토큰으로 화면 세션을 준비한다. 실제 카드 인증 값은 이후 페이지에서 들어온다.
        val (status, prepared) = postApi("/api/payments/prepare", json.createObjectNode().put("token", token))
        if (status !in 200..299) return ResponseEntity.status(status).body(prepared)
        if (prepared["hasReturnUrl"]?.booleanValue() != true) fail(409, "RETURN_URL_REQUIRED", "화면 결제에는 토큰 발급 시 returnUrl이 필요합니다.")
        val returnUrl = runCatching { URI(prepared["returnUrl"].textValue()) }.getOrNull()
        if (returnUrl == null || returnUrl.scheme !in listOf("http", "https") || returnUrl.host == null || returnUrl.userInfo != null || returnUrl.fragment != null)
            fail(502, "INVALID_RETURN_URL", "결제 API의 returnUrl이 올바르지 않습니다.")
        if (prepared["status"]?.textValue() !in listOf("PREPARED", "CARD_SELECTED")) fail(409, "PAYMENT_FINISHED", "이미 처리된 결제입니다.")
        val html = Regex("\\{\\{(\\w+)}}").replace(template) {
            val name = it.groupValues[1]
            val value = if (name == "amount") String.format(Locale.KOREA, "%,d", prepared[name].longValue()) else prepared[name].textValue()
            HtmlUtils.htmlEscape(value)
        }
        val callbackOrigin = "${returnUrl.scheme}://${returnUrl.rawAuthority}"
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self' $callbackOrigin; frame-ancestors 'none'")
        return ResponseEntity.ok().header("Content-Type", "text/html; charset=utf-8").body(html)
    }

    @PostMapping("/api/payments/complete")
    fun complete(request: HttpServletRequest): ResponseEntity<JsonNode> {
        val (status, response) = postApi("/api/payments/complete", body(request))
        return ResponseEntity.status(status).body(response)
    }
    private fun postApi(path: String, body: JsonNode): Pair<Int, JsonNode> {
        val connection = URI(config.paymentApiBaseUrl.trimEnd('/') + path).toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = config.timeoutMs
            connection.readTimeout = config.timeoutMs
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            val bytes = json.writeValueAsBytes(body)
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.use { it.readNBytes(65537) } ?: error("API 응답 본문 없음")
            check(response.size <= 65536)
            val value = json.readTree(response)
            check(value?.isObject == true)
            return status to value
        } catch (_: Exception) { fail(503, "PAYMENT_API_UNAVAILABLE", "결제 API 서버에 연결할 수 없습니다. 서버와 접속 주소를 확인하세요.") }
        finally { connection.disconnect() }
    }
    private fun body(request: HttpServletRequest): JsonNode {
        val bytes = request.inputStream.readNBytes(65537)
        if (bytes.size > 65536) fail(413, "BODY_TOO_LARGE", "요청 본문이 너무 큽니다.")
        val value = try {
            when (request.contentType?.substringBefore(';')?.trim()) {
                "application/json" -> json.readTree(bytes)
                "application/x-www-form-urlencoded" -> json.createObjectNode().also { node ->
                    bytes.toString(Charsets.UTF_8).split('&').filter { it.isNotEmpty() }.forEach { pair ->
                        val parts = pair.split('=', limit = 2)
                        node.put(URLDecoder.decode(parts[0], Charsets.UTF_8), URLDecoder.decode(parts.getOrElse(1) { "" }, Charsets.UTF_8))
                    }
                }
                else -> fail(415, "CONTENT_TYPE", "JSON 또는 폼 본문을 사용하세요.")
            }
        } catch (e: WebFailure) { throw e }
        catch (_: Exception) { fail(400, "INVALID_BODY", "요청 본문을 해석할 수 없습니다.") }
        if (value == null || !value.isObject) fail(400, "INVALID_BODY", "본문은 객체여야 합니다.")
        return value
    }
}

@RestControllerAdvice
class WebErrors {
    @ExceptionHandler(Exception::class)
    fun handle(error: Exception): ResponseEntity<Map<String, String>> {
        val status = when (error) { is WebFailure -> error.status; is ErrorResponse -> error.statusCode.value(); else -> 500 }
        val code = if (error is WebFailure) error.code else if (status < 500) "REQUEST_ERROR" else "INTERNAL_ERROR"
        val message = if (error is WebFailure) error.message!! else if (status < 500) "요청 경로와 메서드를 확인하세요." else "결제 화면 서버 처리 중 오류가 발생했습니다."
        return ResponseEntity.status(status).body(mapOf("code" to code, "message" to message))
    }
}

@Component
class WebHeaders : OncePerRequestFilter() {
    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("X-Content-Type-Options", "nosniff")
        response.setHeader("Referrer-Policy", "no-referrer")
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'")
        chain.doFilter(request, response)
    }
}
