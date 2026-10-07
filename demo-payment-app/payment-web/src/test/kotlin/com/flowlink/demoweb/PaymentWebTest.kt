package com.flowlink.demoweb

import com.fasterxml.jackson.databind.ObjectMapper
import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class PaymentWebTest {
    @LocalServerPort private var port = 0

    @Test
    fun `프론트 복호화 후 인증 결과를 브라우저 form으로 보낼 페이지를 반환한다`() {
        val base = "http://127.0.0.1:$port"
        val client = HttpClient.newHttpClient()
        try {
            fun open(value: String): HttpResponse<String> = client.send(HttpRequest.newBuilder(URI("$base/pay"))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString("encryptedToken=$value")).build(), HttpResponse.BodyHandlers.ofString())
            assertEquals(400, open(TOKEN).statusCode())
            val encrypted = encrypt()
            val corrupted = encrypted.split('.').toMutableList().also { it[2] = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(16)) }
            assertEquals(400, open(corrupted.joinToString(".")).statusCode())
            assertEquals(0, prepareCalls.get())
            val page = open(encrypted)
            assertEquals(200, page.statusCode())
            assertTrue(page.body().contains("토큰 복호화 완료"))
            assertTrue(page.body().contains("현대카드 · 정상 승인"))
            assertTrue(page.body().contains("신한카드 · 정상 승인"))
            assertTrue(page.body().contains("id=\"return-form\" action=\"http://127.0.0.1:19999/merchant?order=1&amp;source=demo\" method=\"post\""))
            assertTrue(page.headers().firstValue("Content-Security-Policy").orElse("").contains("form-action 'self' http://127.0.0.1:19999;"))
            assertFalse(page.body().contains(TOKEN))
            assertFalse(page.body().contains(KEY))
            assertEquals(1, prepareCalls.get())
            assertEquals(200, client.send(HttpRequest.newBuilder(URI("$base/pay.js")).GET().build(), HttpResponse.BodyHandlers.ofString()).statusCode())
            val request = HttpRequest.newBuilder(URI("$base/api/payments/complete")).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("""{"paymentId":"000000000001","pageKey":"page_key","cardIssuer":"HYUNDAI","cardNumber":"1111222233334444"}""")).build()
            val complete = client.send(request, HttpResponse.BodyHandlers.ofString())
            assertEquals(200, complete.statusCode())
            assertEquals("READY", json.readTree(complete.body())["callbackFields"]["code"].textValue())
            assertEquals(1, completeCalls.get())
            backendStatus = 410
            assertEquals(410, open(encrypted).statusCode())
            backendStatus = 200; hasReturnUrl = false
            assertEquals(409, open(encrypted).statusCode())
            api.stop(0)
            assertEquals(503, open(encrypted).statusCode())
        } finally { client.close() }
    }
    companion object {
        private const val KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
        private const val TOKEN = "issued_test_token"
        private val json = ObjectMapper()
        private val prepareCalls = AtomicInteger()
        private val completeCalls = AtomicInteger()
        private var backendStatus = 200
        private var hasReturnUrl = true
        private val api = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/api/payments/prepare") { exchange ->
                val body = json.readTree(exchange.requestBody.readAllBytes())
                check(body["token"].textValue() == TOKEN) // 평문은 서버 간 요청에만 전달한다.
                prepareCalls.incrementAndGet()
                val response = if (backendStatus != 200) """{"code":"TOKEN_EXPIRED","message":"토큰 만료"}"""
                else """{"paymentId":"000000000001","pageKey":"page_key","merchantId":"DEMO_SHOP","orderId":"ORDER_001","amount":10000,"status":"PREPARED","hasReturnUrl":$hasReturnUrl,"returnUrl":"http://127.0.0.1:19999/merchant?order=1&source=demo"}"""
                val bytes = response.toByteArray()
                exchange.sendResponseHeaders(backendStatus, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
            createContext("/api/payments/complete") { exchange ->
                val body = json.readTree(exchange.requestBody.readAllBytes())
                check(body["pageKey"].textValue() == "page_key" && body["cardNumber"].textValue() == "1111222233334444")
                check(body["cardIssuer"].textValue() == "HYUNDAI")
                completeCalls.incrementAndGet()
                val bytes = """{"paymentId":"000000000001","authenticated":true,"returnUrl":"http://127.0.0.1:19999/merchant?order=1&source=demo","callbackFields":{"paymentId":"000000000001","code":"READY"}}""".toByteArray()
                exchange.sendResponseHeaders(200, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
            start()
        }
        @JvmStatic @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) { registry.add("demo-web.payment-api-base-url") { "http://127.0.0.1:${api.address.port}" } }
        @JvmStatic @AfterAll fun stop() { api.stop(0) }
        private fun encrypt(): String {
            val iv = ByteArray(12).also(SecureRandom()::nextBytes)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(Base64.getDecoder().decode(KEY), "AES"), GCMParameterSpec(128, iv))
            val bytes = cipher.doFinal(TOKEN.toByteArray())
            return listOf(iv, bytes.copyOfRange(0, bytes.size - 16), bytes.takeLast(16).toByteArray())
                .joinToString(".") { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
        }
    }
}
