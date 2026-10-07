package com.flowlink.demo

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import java.net.HttpURLConnection
import java.net.URI
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64

class DemoException(val status: Int, val code: String, message: String) : RuntimeException(message)
fun fail(status: Int, code: String, message: String): Nothing = throw DemoException(status, code, message)
fun text(body: JsonNode, name: String): String = body[name]?.takeIf { it.isTextual }?.textValue()
    ?: fail(400, "INVALID_BODY", "$name 문자열을 입력하세요.")

@Service
class PaymentService(private val config: DemoProperties, private val json: ObjectMapper) {
    private val random = SecureRandom()
    private val log = LoggerFactory.getLogger(javaClass)
    // ponytail: 발표 상태 최대 500건을 메모리에 저장. 재시작 복구가 필요하면 DB로 옮긴다.
    private val tokens = linkedMapOf<String, Order>()
    private val payments = linkedMapOf<String, Payment>()
    private var sequence = 0L

    private class Order(val token: String, val merchantId: String, val orderId: String, val amount: Long,
                        val returnUrl: String?, val expiresAt: Long, var paymentId: String? = null)
    private class Payment(val order: Order, val paymentId: String, val pageKey: String) {
        var cardNumber: String? = null
        var cardIssuer: String? = null
        var authenticated = false
        var busy = false
        var approval: Map<String, Any?>? = null
    }

    init {
        val url = URI(config.hyundaiHttpBaseUrl)
        require(url.scheme in listOf("http", "https") && url.host != null && url.userInfo == null && url.query == null && url.fragment == null)
        require(config.shinhanTcpHost.isNotBlank() && config.shinhanTcpPort in 1..65535)
        require(config.timeoutMs in 50..60000 && config.tokenTtlSec in 1..86400)
        require(config.allowedCallbackHosts.all { it.isNotBlank() })
        val pageUrl = URI(config.paymentPageUrl)
        require(pageUrl.scheme in listOf("http", "https") && pageUrl.host != null && pageUrl.userInfo == null)
    }

    private fun randomToken(size: Int): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(size).also(random::nextBytes))
    private fun card(value: String): String {
        if (!value.matches(Regex("\\d{16}"))) fail(400, "INVALID_CARD", "테스트 카드번호는 숫자 16자리여야 합니다.")
        return value
    }
    private fun issuer(body: JsonNode): String {
        val value = text(body, "cardIssuer")
        if (value !in listOf("HYUNDAI", "SHINHAN")) fail(400, "INVALID_CARD_ISSUER", "카드사는 HYUNDAI 또는 SHINHAN을 선택하세요.")
        return value
    }
    private fun callbackUrl(value: String?): String? {
        if (value.isNullOrEmpty()) return null
        val url = runCatching { URI(value) }.getOrNull()
        if (value.length > 2048 || url == null || url.scheme !in listOf("http", "https") || url.host !in config.allowedCallbackHosts
            || url.userInfo != null || url.fragment != null) {
            fail(400, "INVALID_RETURN_URL", "콜백 주소의 호스트를 allowed-callback-hosts에 등록하세요.")
        }
        return value
    }

    @Synchronized
    fun issue(body: JsonNode): Map<String, Any?> {
        val merchantId = text(body, "merchantId")
        val orderId = text(body, "orderId")
        val amountNode = body["amount"]
        if (!merchantId.matches(Regex("[A-Za-z0-9_-]{1,12}")) || !orderId.matches(Regex("[A-Za-z0-9_-]{1,64}"))
            || amountNode == null || !amountNode.isIntegralNumber || !amountNode.canConvertToLong() || amountNode.longValue() !in 1..9999999999L) {
            fail(400, "INVALID_ORDER", "가맹점 ID·주문 ID·정수 금액을 확인하세요.")
        }
        val returnUrl = callbackUrl(if (body.hasNonNull("returnUrl")) text(body, "returnUrl") else null)
        val expired = tokens.filterValues { it.expiresAt <= System.currentTimeMillis() }.keys
        expired.forEach { token -> payments.remove(tokens.remove(token)?.paymentId) }
        if (tokens.size >= 500) fail(503, "DEMO_CAPACITY", "데모 주문 한도에 도달했습니다. 서버를 재시작하세요.")
        val token = randomToken(32)
        val expiresAt = System.currentTimeMillis() + config.tokenTtlSec * 1000
        tokens[token] = Order(token, merchantId, orderId, amountNode.longValue(), returnUrl, expiresAt)
        return mapOf("token" to token, "expiresAt" to Instant.ofEpochMilli(expiresAt).toString(), "paymentUrl" to config.paymentPageUrl)
    }

    @Synchronized
    private fun findToken(token: String): Order {
        val order = tokens[token] ?: fail(404, "TOKEN_NOT_FOUND", "발급되지 않은 토큰입니다.")
        if (order.expiresAt <= System.currentTimeMillis()) fail(410, "TOKEN_EXPIRED", "토큰이 만료되었습니다.")
        return order
    }
    @Synchronized
    private fun findPayment(id: String): Payment {
        val payment = payments[id] ?: fail(404, "PAYMENT_NOT_FOUND", "결제 요청이 없습니다.")
        findToken(payment.order.token)
        return payment
    }
    @Synchronized
    private fun prepareToken(token: String): Payment {
        val order = findToken(token)
        if (order.paymentId == null) {
            val id = (++sequence).toString().padStart(12, '0')
            order.paymentId = id
            payments[id] = Payment(order, id, randomToken(24))
        }
        return findPayment(order.paymentId!!)
    }
    private fun summary(p: Payment): Map<String, Any?> = synchronized(p) {
        mapOf("paymentId" to p.paymentId, "merchantId" to p.order.merchantId, "orderId" to p.order.orderId,
            "amount" to p.order.amount, "status" to (p.approval?.get("status") ?: if (p.authenticated) "AUTHENTICATED" else if (p.cardNumber != null) "CARD_SELECTED" else "PREPARED"),
            "authenticated" to p.authenticated, "cardIssuer" to p.cardIssuer, "cardLast4" to p.cardNumber?.takeLast(4)) + (p.approval ?: emptyMap())
    }
    fun get(id: String): Map<String, Any?> = summary(findPayment(id))

    fun prepare(body: JsonNode): Map<String, Any?> {
        val selected = if (body.hasNonNull("cardNumber")) card(text(body, "cardNumber")) else null
        val selectedIssuer = if (selected != null) issuer(body) else null
        if (selected == null && body.hasNonNull("cardIssuer")) fail(400, "INVALID_CARD", "카드사와 카드번호를 함께 전달하세요.")
        val p = prepareToken(text(body, "token"))
        synchronized(p) {
            if (selected != null) {
                if (p.busy || p.approval != null || p.authenticated) fail(409, "PAYMENT_LOCKED", "처리가 시작된 결제의 카드는 변경할 수 없습니다.")
                p.cardNumber = selected
                p.cardIssuer = selectedIssuer
            }
            return summary(p) + mapOf("pageKey" to p.pageKey, "hasReturnUrl" to (p.order.returnUrl != null), "returnUrl" to p.order.returnUrl)
        }
    }

    private fun post(url: String, body: Map<String, Any?>): JsonNode? {
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
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
            check(connection.responseCode in 200..299)
            val response = connection.inputStream.use { it.readNBytes(65537) }
            check(response.size <= 65536)
            return json.readTree(response)
        } finally { connection.disconnect() }
    }

    fun approve(id: String): Map<String, Any?> {
        val p = findPayment(id)
        val selected: String
        val selectedIssuer: String
        synchronized(p) {
            if (p.busy) fail(409, "PAYMENT_BUSY", "결제를 처리 중입니다.")
            if (p.approval?.get("status") == "UNKNOWN") fail(409, "APPROVAL_UNKNOWN", "카드사 승인 결과가 미확정입니다. 새 테스트 주문을 만드세요.")
            if (p.approval != null) return summary(p)
            selected = p.cardNumber ?: fail(409, "CARD_REQUIRED", "카드를 먼저 선택하거나 결제 준비 요청에 카드번호를 넣으세요.")
            selectedIssuer = p.cardIssuer ?: fail(409, "CARD_REQUIRED", "카드사를 먼저 선택하세요.")
            p.busy = true
        }
        val stage = if (selectedIssuer == "HYUNDAI") "HTTP" else "TCP"
        try {
            // 전송 후 연결 단절은 승인됐는지 모호하다. 결과 확인 없이 재승인하지 않는다.
            synchronized(p) { p.approval = mapOf("status" to "UNKNOWN", "code" to "APPROVAL_UNKNOWN", "stage" to stage, "approvalNo" to null) }
            val (responseCode, approvalNo) = if (selectedIssuer == "HYUNDAI") {
                try {
                    val response = post(config.hyundaiHttpBaseUrl.trimEnd('/') + "/authorize",
                        mapOf("paymentId" to p.paymentId, "cardNumber" to selected, "amount" to p.order.amount))
                    check(response?.get("responseCode")?.isTextual == true && response["approvalNo"]?.isTextual == true)
                    val code = response!!["responseCode"].textValue()
                    val approval = response["approvalNo"].textValue()
                    check(code.matches(Regex("\\d{4}")) && approval.length <= 32 && (code != "0000" || approval.isNotBlank()))
                    code to approval
                } catch (_: Exception) { fail(502, "HYUNDAI_HTTP_ERROR", "현대카드 HTTP 승인에 실패했습니다. 결과가 미확정이므로 새 테스트 주문을 만드세요.") }
            } else {
                try { CardTcp.call(p.paymentId, selected, p.order.amount, p.order.merchantId, config) }
                catch (_: Exception) { fail(502, "SHINHAN_TCP_ERROR", "신한카드 TCP 승인에 실패했습니다. 결과가 미확정이므로 새 테스트 주문을 만드세요.") }
            }
            synchronized(p) { p.approval = mapOf("status" to if (responseCode == "0000") "APPROVED" else "DECLINED",
                "code" to responseCode, "stage" to stage, "approvalNo" to approvalNo) }
            log.info("{} issuer={} paymentId={} card=••••{} code={}", stage, selectedIssuer, p.paymentId, selected.takeLast(4), responseCode)
            return summary(p)
        } finally { synchronized(p) { p.busy = false } }
    }

    fun complete(body: JsonNode): Map<String, Any?> {
        val p = findPayment(text(body, "paymentId"))
        val selected = card(text(body, "cardNumber"))
        val selectedIssuer = issuer(body)
        synchronized(p) {
            if (text(body, "pageKey") != p.pageKey) fail(403, "INVALID_PAGE_SESSION", "결제 화면의 세션이 올바르지 않습니다.")
            if (p.order.returnUrl == null) fail(409, "RETURN_URL_REQUIRED", "콜백 주소가 없습니다.")
            if (p.authenticated) {
                if (p.cardNumber != selected || p.cardIssuer != selectedIssuer) fail(409, "PAYMENT_LOCKED", "인증된 카드는 변경할 수 없습니다.")
            } else if (p.busy || p.approval != null) fail(409, "PAYMENT_LOCKED", "처리 중이거나 완료된 결제입니다.")
            p.cardNumber = selected
            p.cardIssuer = selectedIssuer
            p.authenticated = true
            // 가맹점 returnUrl 전송은 브라우저 form POST가 담당한다. API는 전달 완료를 추정하지 않는다.
            return summary(p) + mapOf("returnUrl" to p.order.returnUrl, "callbackFields" to mapOf(
                "paymentId" to p.paymentId, "merchantId" to p.order.merchantId, "orderId" to p.order.orderId,
                "amount" to p.order.amount, "code" to "READY", "cardIssuer" to selectedIssuer, "cardLast4" to selected.takeLast(4)))
        }
    }
}
