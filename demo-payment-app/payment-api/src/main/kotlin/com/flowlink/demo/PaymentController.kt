package com.flowlink.demo

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.ResponseEntity
import org.springframework.stereotype.Component
import org.springframework.web.ErrorResponse
import org.springframework.web.bind.annotation.*
import org.springframework.web.filter.OncePerRequestFilter
import java.net.URLDecoder

@RestController
class PaymentController(private val service: PaymentService, private val json: ObjectMapper) {
    @GetMapping("/health") fun health() = mapOf("status" to "UP", "application" to "demo-payment-api")
    @GetMapping("/") fun home() = mapOf("application" to "demo-payment-api", "role" to "토큰 발급·결제 준비·승인 API 서버")
    @GetMapping("/api/payments/{paymentId}") fun payment(@PathVariable paymentId: String) = service.get(paymentId)

    @PostMapping("/api/tokens", "/api/payments/prepare", "/api/payments/complete", "/api/payments/approve")
    fun post(request: HttpServletRequest): ResponseEntity<*> {
        val body = body(request)
        return when (request.requestURI) {
            "/api/tokens" -> ResponseEntity.status(201).body(service.issue(body))
            "/api/payments/prepare" -> ResponseEntity.ok(service.prepare(body))
            "/api/payments/complete" -> ResponseEntity.ok(service.complete(body))
            else -> ResponseEntity.ok(service.approve(text(body, "paymentId")))
        }
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
        } catch (e: DemoException) { throw e }
        catch (_: Exception) { fail(400, "INVALID_BODY", "요청 본문을 해석할 수 없습니다.") }
        if (value == null || !value.isObject) fail(400, "INVALID_BODY", "본문은 객체여야 합니다.")
        return value
    }
}

@RestControllerAdvice
class DemoErrors {
    @ExceptionHandler(Exception::class)
    fun handle(error: Exception): ResponseEntity<Map<String, String>> {
        val status = when (error) { is DemoException -> error.status; is ErrorResponse -> error.statusCode.value(); else -> 500 }
        val code = if (error is DemoException) error.code else if (status < 500) "REQUEST_ERROR" else "INTERNAL_ERROR"
        val message = if (error is DemoException) error.message!! else if (status < 500) "요청 경로와 메서드를 확인하세요." else "데모 서버 처리 중 오류가 발생했습니다."
        return ResponseEntity.status(status).body(mapOf("code" to code, "message" to message))
    }
}

@Component
class DemoHeaders : OncePerRequestFilter() {
    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("X-Content-Type-Options", "nosniff")
        response.setHeader("Referrer-Policy", "no-referrer")
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'")
        chain.doFilter(request, response)
    }
}
