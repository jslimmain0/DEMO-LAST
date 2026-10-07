package com.flowlink.demo

import java.io.DataInputStream
import java.net.InetSocketAddress
import java.net.Socket

object CardTcp {
    // ASCII. 4자리 길이는 자기 자신을 제외한다.
    // 요청: 0054 + AUTH(4) + paymentId(12) + cardNumber(16) + amount(10) + merchantId(12)
    // 응답: 0028 + RESP(4) + paymentId(12) + responseCode(4) + approvalNo(8)
    fun request(paymentId: String, cardNumber: String, amount: Long, merchantId: String): ByteArray =
        ("0054AUTH" + paymentId + cardNumber + amount.toString().padStart(10, '0') + merchantId.padEnd(12, ' ')).toByteArray(Charsets.US_ASCII)

    fun call(paymentId: String, cardNumber: String, amount: Long, merchantId: String, config: DemoProperties): Pair<String, String> =
        Socket().use { socket ->
            socket.connect(InetSocketAddress(config.shinhanTcpHost, config.shinhanTcpPort), config.timeoutMs)
            socket.soTimeout = config.timeoutMs
            socket.getOutputStream().write(request(paymentId, cardNumber, amount, merchantId))
            val input = DataInputStream(socket.getInputStream())
            val header = ByteArray(4).also { input.readFully(it) }
            require(header.toString(Charsets.US_ASCII) == "0028") { "TCP 길이 필드 오류" }
            val bodyBytes = ByteArray(28).also { input.readFully(it) }
            require(bodyBytes.all { (it.toInt() and 255) <= 127 }) { "TCP 문자셋 오류" }
            val body = bodyBytes.toString(Charsets.US_ASCII)
            require(body.startsWith("RESP") && body.substring(4, 16) == paymentId
                && body.substring(16, 20).matches(Regex("\\d{4}"))
                && body.substring(20).matches(Regex("[A-Za-z0-9 ]{8}"))) { "TCP 거래 정보 오류" }
            body.substring(16, 20) to body.substring(20).trim()
        }
}
