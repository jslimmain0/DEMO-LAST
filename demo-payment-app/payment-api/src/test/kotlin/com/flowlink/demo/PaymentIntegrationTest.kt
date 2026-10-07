package com.flowlink.demo

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import java.io.DataInputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class PaymentIntegrationTest {
    @LocalServerPort private var port: Int = 0

    @Test
    fun `API 인증 결과와 HTTP TCP 및 실패 처리`() {
        base = "http://127.0.0.1:$port"
        assertEquals(200, get("/health").statusCode())
        assertEquals(400, post("/api/tokens", mapOf("merchantId" to "bad<script>", "orderId" to "x", "amount" to -1)).first)
        assertEquals(400, post("/api/tokens", mapOf("merchantId" to "DEMO", "orderId" to "x", "amount" to 10.5)).first)
        assertEquals(400, post("/api/tokens", mapOf("merchantId" to "DEMO", "orderId" to "x", "amount" to 10000, "returnUrl" to "http://169.254.169.254/")).first)
        assertEquals(400, post("/api/tokens", emptyList<String>()).first)
        assertEquals(413, post("/api/tokens", mapOf("data" to "x".repeat(66000))).first)
        assertEquals(405, get("/api/tokens").statusCode())
        assertEquals(404, get("/missing").statusCode())
        assertEquals(404, get("/pay").statusCode())
        assertEquals(404, get("/pay.js").statusCode())
        assertEquals(404, post("/pay", mapOf("encryptedToken" to "invalid")).first)

        val sample = CardTcp.request("000000000001", "1111222233334444", 10000, "DEMO_SHOP")
        val spec = json.readTree(Path.of("../card-protocol.json").toFile())
        assertEquals(58, sample.size)
        assertEquals(sample.size, spec["header"].sumOf { it["len"].intValue() } + spec["messages"][0]["fields"].sumOf { it["len"].intValue() })
        assertEquals("0000010000", sample.copyOfRange(36, 46).toString(Charsets.US_ASCII))

        val id = prepare()
        val approved = post("/api/payments/approve", mapOf("paymentId" to id))
        assertEquals(200, approved.first)
        assertEquals("APPROVED", approved.second["status"].textValue())
        assertEquals("DEMO0001", approved.second["approvalNo"].textValue())
        assertEquals("SHINHAN", approved.second["cardIssuer"].textValue())
        assertEquals(0, httpCalls.get())
        val before = cardCalls.get()
        assertEquals(approved, post("/api/payments/approve", mapOf("paymentId" to id)))
        assertEquals(before, cardCalls.get())
        assertEquals(404, post("/api/payments/prepare", mapOf("token" to "not-issued")).first)
        assertEquals("1001", post("/api/payments/approve", mapOf("paymentId" to prepare("9999000011112222"))).second["code"].textValue())

        externalCode = "1001"
        val beforeDenied = cardCalls.get()
        val declined = post("/api/payments/approve", mapOf("paymentId" to prepare(issuer = "HYUNDAI")))
        assertEquals("HTTP", declined.second["stage"].textValue())
        assertEquals("DECLINED", declined.second["status"].textValue())
        assertEquals("1001", declined.second["code"].textValue())
        assertEquals(beforeDenied, cardCalls.get())
        externalCode = "0000"; externalStatus = 500
        val unknownHttpId = prepare(issuer = "HYUNDAI")
        assertEquals("HYUNDAI_HTTP_ERROR", post("/api/payments/approve", mapOf("paymentId" to unknownHttpId)).second["code"].textValue())
        val httpCallsAfterFailure = httpCalls.get()
        assertEquals("APPROVAL_UNKNOWN", post("/api/payments/approve", mapOf("paymentId" to unknownHttpId)).second["code"].textValue())
        assertEquals(httpCallsAfterFailure, httpCalls.get())
        // 현대카드 HTTP가 장애여도 신한카드는 TCP만 호출한다.
        assertEquals("APPROVED", post("/api/payments/approve", mapOf("paymentId" to prepare())).second["status"].textValue())
        assertEquals(httpCallsAfterFailure, httpCalls.get())
        externalStatus = 200

        val token = issue(true)
        val prepared = post("/api/payments/prepare", mapOf("token" to token))
        assertEquals(200, prepared.first)
        assertTrue(prepared.second["hasReturnUrl"].booleanValue())
        val paymentId = prepared.second["paymentId"].textValue()
        val pageKey = prepared.second["pageKey"].textValue()
        assertEquals(403, post("/api/payments/complete", mapOf("paymentId" to paymentId, "pageKey" to "wrong", "cardIssuer" to "SHINHAN", "cardNumber" to "1111222233334444")).first)
        val completeBody = mapOf("paymentId" to paymentId, "pageKey" to pageKey, "cardIssuer" to "SHINHAN", "cardNumber" to "1111222233334444")
        val completed = post("/api/payments/complete", completeBody)
        assertEquals(200, completed.first)
        assertTrue(completed.second["authenticated"].booleanValue())
        assertFalse(completed.second.has("callbackDelivered"))
        assertEquals("AUTHENTICATED", completed.second["status"].textValue())
        assertEquals("http://127.0.0.1:${http.address.port}/cb", completed.second["returnUrl"].textValue())
        assertEquals("READY", completed.second["callbackFields"]["code"].textValue())
        assertFalse(completed.second["callbackFields"].has("cardNumber"))
        assertFalse(completed.second["callbackFields"].has("pageKey"))
        assertEquals(0, callbackCalls.get()) // API는 returnUrl을 호출하지 않고 브라우저가 form POST한다.
        assertEquals(completed, post("/api/payments/complete", completeBody))
        assertEquals(409, post("/api/payments/complete", completeBody + ("cardIssuer" to "HYUNDAI")).first)
        assertEquals("APPROVED", post("/api/payments/approve", mapOf("paymentId" to paymentId)).second["status"].textValue())
        assertEquals("APPROVED", json.readTree(get("/api/payments/$paymentId").body())["status"].textValue())

        val concurrentId = prepare()
        val concurrentBefore = cardCalls.get()
        val outcomes = Executors.newVirtualThreadPerTaskExecutor().use { executor ->
            (1..2).map { executor.submit<Pair<Int, JsonNode>> { post("/api/payments/approve", mapOf("paymentId" to concurrentId)) } }.map { it.get().first }
        }
        assertEquals(listOf(200, 409), outcomes.sorted())
        assertEquals(concurrentBefore + 1, cardCalls.get())
        truncated = true
        val unknownId = prepare()
        assertEquals("SHINHAN_TCP_ERROR", post("/api/payments/approve", mapOf("paymentId" to unknownId)).second["code"].textValue())
        val beforeRetry = cardCalls.get()
        assertEquals("APPROVAL_UNKNOWN", post("/api/payments/approve", mapOf("paymentId" to unknownId)).second["code"].textValue())
        assertEquals(beforeRetry, cardCalls.get())
        // TCP Mock을 만들기 전에도 현대카드 시연은 끝까지 성공해야 한다.
        tcp.close()
        val httpOnly = post("/api/payments/approve", mapOf("paymentId" to prepare(issuer = "HYUNDAI")))
        assertEquals(200, httpOnly.first)
        assertEquals("APPROVED", httpOnly.second["status"].textValue())
        assertEquals("HTTP", httpOnly.second["stage"].textValue())
        assertEquals("HYUN0001", httpOnly.second["approvalNo"].textValue())
        assertEquals(beforeRetry, cardCalls.get())
        assertEquals(400, post("/api/payments/prepare", mapOf("token" to issue(), "cardIssuer" to "OTHER", "cardNumber" to "1111222233334444")).first)
    }

    companion object {
        private val json = ObjectMapper()
        private val client = HttpClient.newHttpClient()
        private val executor = Executors.newVirtualThreadPerTaskExecutor()
        private val cardCalls = AtomicInteger()
        private val httpCalls = AtomicInteger()
        private val callbackCalls = AtomicInteger()
        private val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        private val tcp = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
        @Volatile private var externalCode = "0000"
        @Volatile private var externalStatus = 200
        @Volatile private var truncated = false
        private lateinit var base: String

        init {
            http.executor = executor
            http.createContext("/hyundai/authorize") { exchange ->
                val payload = json.readTree(exchange.requestBody.readAllBytes())
                check(payload["amount"].longValue() == 10000L)
                check(payload.fieldNames().asSequence().toSet() == setOf("paymentId", "cardNumber", "amount"))
                check(payload["paymentId"].textValue().matches(Regex("\\d{12}")))
                check(payload["cardNumber"].textValue().matches(Regex("\\d{16}")))
                httpCalls.incrementAndGet()
                val approval = if (externalCode == "0000") "HYUN0001" else ""
                val bytes = "{\"responseCode\":\"$externalCode\",\"approvalNo\":\"$approval\"}".toByteArray()
                exchange.sendResponseHeaders(externalStatus, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
            http.createContext("/cb") { exchange ->
                callbackCalls.incrementAndGet()
                exchange.sendResponseHeaders(503, 2)
                exchange.responseBody.use { it.write("OK".toByteArray()) }
            }
            http.start()
            executor.submit {
                while (!tcp.isClosed) {
                    val socket = try { tcp.accept() } catch (_: Exception) { break }
                    executor.submit {
                        socket.use {
                            val request = ByteArray(58).also { bytes -> DataInputStream(socket.getInputStream()).readFully(bytes) }
                            check(request.copyOfRange(0, 8).toString(Charsets.US_ASCII) == "0054AUTH")
                            cardCalls.incrementAndGet()
                            if (truncated) socket.getOutputStream().write("0028RESP".toByteArray())
                            else {
                                val id = request.copyOfRange(8, 20).toString(Charsets.US_ASCII)
                                val number = request.copyOfRange(20, 36).toString(Charsets.US_ASCII)
                                val result = if (number == "9999000011112222") "1001        " else "0000DEMO0001"
                                val response = "0028RESP$id$result"
                                socket.getOutputStream().write(response.take(3).toByteArray())
                                Thread.sleep(30)
                                socket.getOutputStream().write(response.drop(3).toByteArray())
                            }
                        }
                    }
                }
            }
        }
        @JvmStatic @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("demo.hyundai-http-base-url") { "http://127.0.0.1:${http.address.port}/hyundai" }
            registry.add("demo.shinhan-tcp-port") { tcp.localPort }
            registry.add("demo.timeout-ms") { 1000 }
        }
        @JvmStatic @AfterAll
        fun stop() { http.stop(0); tcp.close(); executor.close(); client.close() }

        private fun post(path: String, body: Any): Pair<Int, JsonNode> {
            val request = HttpRequest.newBuilder(URI(base + path)).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(body))).build()
            val response = client.send(request, HttpResponse.BodyHandlers.ofString())
            return response.statusCode() to json.readTree(response.body())
        }
        private fun get(path: String): HttpResponse<String> = client.send(HttpRequest.newBuilder(URI(base + path)).GET().build(), HttpResponse.BodyHandlers.ofString())
        private fun issue(callback: Boolean = false): String {
            val body = mutableMapOf<String, Any>("merchantId" to "DEMO_SHOP", "orderId" to "ORDER_${System.nanoTime()}", "amount" to 10000)
            if (callback) body["returnUrl"] = "http://127.0.0.1:${http.address.port}/cb"
            val issued = post("/api/tokens", body)
            assertEquals(201, issued.first)
            return issued.second["token"].textValue()
        }
        private fun prepare(card: String = "1111222233334444", issuer: String = "SHINHAN"): String {
            val prepared = post("/api/payments/prepare", mapOf("token" to issue(), "cardIssuer" to issuer, "cardNumber" to card))
            assertEquals(200, prepared.first)
            return prepared.second["paymentId"].textValue()
        }
    }
}
