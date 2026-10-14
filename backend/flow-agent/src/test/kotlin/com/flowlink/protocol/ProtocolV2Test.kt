package com.flowlink.protocol

import com.flowlink.mock.MockRuntimeStore
import com.flowlink.mock.MockSpec
import com.flowlink.mock.TcpMockSession
import com.flowlink.common.tcp.TcpBytes
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper

class ProtocolV2Test {
    private val header = listOf(ProtocolSpec.Field("code", 2, "ascii"), ProtocolSpec.Field("tid", 9, "ascii"), ProtocolSpec.Field("phone", 12, "ascii", "right/nul"), ProtocolSpec.Field("reserved", 52, "ascii"))
    private val sizes = listOf(Triple("F1", 137, 270), Triple("G1", 624, 266), Triple("H1", 263, 129), Triple("V1", 243, 268), Triple("Y1", 244, 128), Triple("M1", 243, 268), Triple("Z1", 141, 128), Triple("W1", 387, 257), Triple("X1", 264, 130))
    private fun ack(strict: Boolean = false) = ProtocolSpec.Ack(
        ProtocolSpec.AckSend("message", messageKey = "ack", values = mapOf("prefix" to "00  ", "tid" to "{{req.tid}}", "version" to "V001", "phone" to "{{req.phone}}", "filler" to "00")),
        if (strict) ProtocolSpec.AckReceive("fields", messageKey = "ack", expected = mapOf("tid" to "{{req.tid}}", "phone" to "{{req.phone}}")) else ProtocolSpec.AckReceive("length-only", lengthBytes = 30), 500)
    private fun spec(strict: Boolean = false, keep: Boolean = true): ProtocolSpec = ProtocolSpec(encoding = "EUC-KR", header = header, schemaVersion = 2,
        transport = ProtocolSpec.Transport(if (keep) "execution" else "once", idleTimeoutMs = 1000),
        messages = sizes.flatMap { (code, request, response) -> listOf(
            ProtocolSpec.Message("$code:request", fields = listOf(ProtocolSpec.Field("payload", request - 75, "ascii"))),
            ProtocolSpec.Message("$code:response", fields = listOf(ProtocolSpec.Field("result", 2, "ascii"), ProtocolSpec.Field("echoTid", 9, "ascii"), ProtocolSpec.Field("body", response - 86, "ascii")))) },
        transactions = sizes.map { (code, request, response) -> ProtocolSpec.Transaction(code, listOf(ProtocolSpec.Selection("code", "eq", code)), "$code:request", "$code:response", ProtocolSpec.Framing("fixed", fixedLength = request), ProtocolSpec.Framing("fixed", fixedLength = response), responseAck = if (code in setOf("G1", "H1", "W1", "X1")) ack(strict) else null) },
        ackMessages = listOf(ProtocolSpec.AckMessage("ack", fields = listOf(ProtocolSpec.Field("prefix", 4, "ascii", "none"), ProtocolSpec.Field("tid", 9, "ascii", "right/nul"), ProtocolSpec.Field("version", 4, "ascii", "none"), ProtocolSpec.Field("phone", 12, "ascii", "right/nul"), ProtocolSpec.Field("filler", 1, "binary", "none")))))
    private fun values(tid: String = "000000001") = mapOf("tid" to tid, "phone" to "01000000000", "reserved" to "", "payload" to "SYNTHETIC")
    private val tcp = MockSpec.MockTcp(12345, "test", rules = listOf(MockSpec.MockTcpRule("ok", then = MockSpec.MockTcpThen("mock", mapOf("result" to "00", "echoTid" to "{{req.tid}}", "body" to "fixture")))))

    private fun <T> withServer(spec: ProtocolSpec, block: (Int, MutableList<MockRuntimeStore.TcpLogEntry>) -> T): T {
        val logs = Collections.synchronizedList(mutableListOf<MockRuntimeStore.TcpLogEntry>())
        val executor = Executors.newCachedThreadPool()
        ServerSocket(0).use { server ->
            val accept = executor.submit {
                while (!server.isClosed) {
                    val socket = try { server.accept() } catch (_: Exception) { break }
                    executor.submit { socket.use { peer ->
                        peer.soTimeout = 1000
                        TcpMockSession(spec, tcp, ProtocolCodec.NO_PLUGINS, emptyMap(), { 1001 }, { logs.add(it) }, { null }, ackTimeout = { peer.soTimeout = it ?: 1000 }).serve(peer.getInputStream().buffered(), peer.getOutputStream()) { peer.close() }
                    } }
                }
            }
            try { return block(server.localPort, logs) }
            finally { server.close(); accept.get(2, TimeUnit.SECONDS); executor.shutdownNow(); executor.awaitTermination(2, TimeUnit.SECONDS) }
        }
    }

    @Test fun `LGU 아홉 거래가 같은 리스너에서 요청 응답 길이와 마지막 ACK를 선택한다`() {
        val spec = spec()
        assertThat(spec.validate()).isEmpty()
        withServer(spec) { port, logs ->
            TcpClient.Session("127.0.0.1", port, 1500).use { client ->
                sizes.forEachIndexed { index, (code, requestBytes, responseBytes) ->
                    val tid = (index + 1).toString().padStart(9, '0')
                    val encoded = ProtocolCompiler.assemble(spec, values = values(tid), transactionKey = code)
                    assertThat(encoded.bytes.size).isEqualTo(requestBytes)
                    val exchange = client.exchange(encoded.bytes, spec)
                    assertThat(exchange.response.bytes.size).isEqualTo(responseBytes)
                    assertThat(exchange.transactionKey).isEqualTo(code)
                    assertThat(ProtocolCompiler.parse(spec, exchange.response.bytes, transactionKey = code, phase = "response").values["echoTid"]).isEqualTo(tid)
                    assertThat(exchange.steps.last().phase).isEqualTo("COMPLETE")
                }
            }
            await { logs.count { it.phase == "COMPLETE" } == sizes.size }
            assertThat(logs.filter { it.phase == "RESPONSE_ACK" && it.status == "SUCCEEDED" }).hasSize(4)
        }
    }

    @Test fun `분할 ACK와 다음 요청을 합쳐 보내도 같은 소켓의 다음 전문을 보존한다`() {
        val spec = spec()
        withServer(spec) { port, logs -> Socket("127.0.0.1", port).use { client ->
            client.soTimeout = 1500
            val input = client.getInputStream().buffered(); val output = client.getOutputStream()
            val first = ProtocolCompiler.assemble(spec, values = values(), transactionKey = "G1")
            output.write(first.bytes); output.flush()
            assertThat(input.readNBytes(266)).hasSize(266)
            val ack = ProtocolCompiler.assemble(spec, transactionKey = "G1", phase = "responseAck", requestFields = first.values)
            assertThat(ack.bytes).hasSize(30)
            assertThat(ack.bytes.last()).isZero()
            output.write(ack.bytes, 0, 1); output.flush()
            Thread.sleep(40)
            assertThat(logs.any { it.phase == "COMPLETE" }).isFalse()
            val next = ProtocolCompiler.assemble(spec, values = values("000000002"), transactionKey = "F1")
            output.write(ack.bytes.copyOfRange(1, ack.bytes.size) + next.bytes); output.flush()
            val response = input.readNBytes(270)
            assertThat(response).hasSize(270)
            assertThat(ProtocolCompiler.parse(spec, response, transactionKey = "F1", phase = "response").values["echoTid"]).isEqualTo("000000002")
            await { logs.count { it.phase == "COMPLETE" } == 2 }
        } }
    }

    @Test fun `마지막 ACK 일부 뒤 EOF는 응답을 보존하고 COMPLETE를 기록하지 않는다`() {
        val spec = spec()
        withServer(spec) { port, logs ->
            Socket("127.0.0.1", port).use { client ->
                client.soTimeout = 1500
                client.getOutputStream().write(ProtocolCompiler.assemble(spec, values = values(), transactionKey = "G1").bytes)
                assertThat(client.getInputStream().readNBytes(266)).hasSize(266)
                client.getOutputStream().write(byteArrayOf(1)); client.getOutputStream().flush(); client.shutdownOutput()
                await { logs.any { it.errorCode == "ACK_EOF" } }
            }
            assertThat(logs.single { it.errorCode == "ACK_EOF" }.actualBytes).isEqualTo(1)
            assertThat(logs.any { it.phase == "RESPONSE" && it.status == "SUCCEEDED" && it.bytes == 266 }).isTrue()
            assertThat(logs.any { it.phase == "COMPLETE" }).isFalse()
        }
    }

    @Test fun `ACK timeout과 필드 불일치가 다른 오류로 남는다`() {
        for ((strict, expected) in listOf(false to "ACK_TIMEOUT", true to "ACK_MISMATCH")) {
            val spec = spec(strict)
            withServer(spec) { port, logs -> Socket("127.0.0.1", port).use { client ->
                client.soTimeout = 1500
                val request = ProtocolCompiler.assemble(spec, values = values(), transactionKey = "G1")
                client.getOutputStream().write(request.bytes)
                assertThat(client.getInputStream().readNBytes(266)).hasSize(266)
                if (strict) {
                    val ack = ProtocolCompiler.assemble(spec, transactionKey = "G1", phase = "responseAck", requestFields = request.values).bytes
                    ack[4] = '9'.code.toByte()
                    client.getOutputStream().write(ack)
                }
                await { logs.any { it.errorCode == expected } }
                assertThat(logs.any { it.phase == "COMPLETE" }).isFalse()
            } }
        }
    }

    @Test fun `integer는 1 2 4 8바이트 signed endian과 큰 unsigned 값을 정확히 왕복한다`() {
        for (length in listOf(1, 2, 4, 8)) for (endian in listOf("big", "little")) for (signed in listOf(true, false)) {
            val field = ProtocolSpec.Field("number", length, "integer", endian = endian, signed = signed)
            val value = if (signed) "-1" else java.math.BigInteger.ONE.shiftLeft(length * 8).subtract(java.math.BigInteger.ONE).toString()
            val encoded = ProtocolCodec.encodeFields(listOf(field), mapOf("number" to value), "UTF-8")
            assertThat(ProtocolCodec.decodeFields(listOf(field), encoded.bytes, "UTF-8").first["number"]).isEqualTo(value)
            assertThatThrownBy { ProtocolCodec.encodeFields(listOf(field), mapOf("number" to "1.5"), "UTF-8") }.hasMessageContaining("10진")
            val overflow = java.math.BigInteger.ONE.shiftLeft(if (signed) length * 8 - 1 else length * 8).toString()
            assertThatThrownBy { ProtocolCodec.encodeFields(listOf(field), mapOf("number" to overflow), "UTF-8") }.hasMessageContaining("범위")
        }
        val field = ProtocolSpec.Field("n", 4, "integer", endian = "big", signed = true)
        assertThat(TcpBytes.hexDump(ProtocolCodec.encodeFields(listOf(field), mapOf("n" to "130"), "UTF-8").bytes)).isEqualTo("00 00 00 82")
        assertThat(TcpBytes.hexDump(ProtocolCodec.encodeFields(listOf(field), mapOf("n" to "4"), "UTF-8").bytes)).isEqualTo("00 00 00 04")
    }

    @Test fun `SKT int4 47바이트 접수 ACK와 요청 기반 마지막 ACK가 두 거래번호로 완결된다`() {
        val int4 = { name: String -> ProtocolSpec.Field(name, 4, "integer", endian = "big", signed = true) }
        val sktHeader = listOf(ProtocolSpec.Field("sourceId", 5, "ascii", "right/nul"), ProtocolSpec.Field("destId", 5, "ascii", "right/nul"), int4("msgType"), int4("msgId"), int4("result"), ProtocolSpec.Field("tid", 21, "ascii", "right/nul"), ProtocolSpec.Field("msgLen", 4, "length"))
        val ackFields = sktHeader.dropLast(1) + int4("msgLen")
        val requestAck = ProtocolSpec.Ack(ProtocolSpec.AckSend("hex", "00".repeat(47)), ProtocolSpec.AckReceive("length-only", lengthBytes = 47), 500)
        val responseAck = ProtocolSpec.Ack(ProtocolSpec.AckSend("message", messageKey = "sktAck", values = mapOf("sourceId" to "{{req.sourceId}}", "destId" to "{{req.destId}}", "msgType" to "4", "msgId" to "{{req.msgId}}", "result" to "0", "tid" to "{{req.tid}}", "msgLen" to "0")), ProtocolSpec.AckReceive("fields", messageKey = "sktAck", expected = mapOf("tid" to "{{req.tid}}", "msgId" to "{{req.msgId}}", "msgType" to "4")), 500)
        val spec = ProtocolSpec(encoding = "UTF-8", schemaVersion = 2, header = sktHeader, lengthField = "msgLen", lengthFormat = "binary", endian = "big", framing = ProtocolSpec.Framing("length", lengthAdjustment = 47), responseFraming = ProtocolSpec.Framing("length", lengthAdjustment = 47),
            messages = listOf(ProtocolSpec.Message("skt:request", fields = listOf(ProtocolSpec.Field("body", 4, "ascii"))), ProtocolSpec.Message("skt:response", fields = listOf(ProtocolSpec.Field("body", 4, "ascii")))),
            transactions = listOf(ProtocolSpec.Transaction("skt", listOf(ProtocolSpec.Selection("msgType", "eq", "4"), ProtocolSpec.Selection("msgId", "eq", "130")), "skt:request", "skt:response", requestAck = requestAck, responseAck = responseAck)), ackMessages = listOf(ProtocolSpec.AckMessage("sktAck", fields = ackFields)))
        assertThat(spec.headerLen()).isEqualTo(47)
        val executor = Executors.newSingleThreadExecutor()
        val logs = Collections.synchronizedList(mutableListOf<MockRuntimeStore.TcpLogEntry>())
        ServerSocket(0).use { server ->
            val serving = executor.submit { repeat(2) { server.accept().use { peer ->
                peer.soTimeout = 1000
                val rules = MockSpec.MockTcp(12345, "skt", rules = listOf(MockSpec.MockTcpRule("ok", then = MockSpec.MockTcpThen("mock", mapOf("body" to "PASS")))))
                TcpMockSession(spec, rules, ProtocolCodec.NO_PLUGINS, emptyMap(), { 1 }, { logs.add(it) }, { null }, ackTimeout = { peer.soTimeout = it ?: 1000 }).serve(peer.getInputStream().buffered(), peer.getOutputStream()) { peer.close() }
            } } }
            try {
                for (tid in listOf("000000000000000000001", "000000000000000000002")) {
                    val request = ProtocolCompiler.assemble(spec, transactionKey = "skt", values = mapOf("sourceId" to "MOCK1", "destId" to "MOCK2", "result" to "0", "tid" to tid, "body" to "TEST"))
                    assertThat(TcpBytes.hexDump(request.bytes.copyOfRange(43, 47))).isEqualTo("00 00 00 04")
                    val exchange = TcpClient.exchange("127.0.0.1", server.localPort, 1500, request.bytes, spec)
                    assertThat(exchange.requestAck).hasSize(47)
                    assertThat(exchange.responseAck).hasSize(47)
                    assertThat(exchange.steps.map { it.phase }).containsExactly("REQUEST", "REQUEST_ACK", "RESPONSE", "RESPONSE_ACK", "COMPLETE")
                    assertThat(ProtocolCompiler.parse(spec, exchange.responseAck!!, transactionKey = "skt", phase = "responseAck", requestFields = request.values).values["tid"]).isEqualTo(tid)
                }
                serving.get(3, TimeUnit.SECONDS)
                assertThat(logs.count { it.phase == "COMPLETE" }).isEqualTo(2)
            } finally { executor.shutdownNow() }
        }
    }

    @Test fun `NUL padding은 공백과 다르고 v2 한글 초과는 잘리지 않는다`() {
        val field = ProtocolSpec.Field("text", 5, "string", "right/nul")
        val encoded = ProtocolCodec.encodeFields(listOf(field), mapOf("text" to "한글"), "EUC-KR")
        assertThat(encoded.bytes.last()).isZero()
        assertThat(ProtocolCodec.decodeFields(listOf(field), encoded.bytes, "EUC-KR").first["text"]).isEqualTo("한글")
        assertThatThrownBy { ProtocolCodec.encodeFields(listOf(field), mapOf("text" to "한글값"), "EUC-KR") }.hasMessageContaining("초과")
    }

    @Test fun `미매칭 모호한 거래 미완성 전문과 없는 ACK 바인딩은 명시적으로 실패한다`() {
        val spec = spec()
        assertThatThrownBy { ProtocolCompiler.compile(spec.copy(transactions = spec.transactions!! + spec.transactions!!.first().copy(key = "duplicate"))) }
            .isInstanceOf(ProtocolCompiler.CompileException::class.java).hasMessageContaining("동시에")
        assertThatThrownBy { ProtocolCompiler.compile(spec).select(mapOf("code" to "T1")) }.hasMessageContaining("일치하는 거래")
        val request = ProtocolCompiler.assemble(spec, transactionKey = "F1", values = values())
        assertThatThrownBy { ProtocolCompiler.parse(spec, request.bytes.copyOf(request.bytes.size - 1)) }.isInstanceOf(ProtocolCompiler.ProtocolFailure::class.java)
        assertThatThrownBy { ProtocolCompiler.parse(spec, request.bytes + byteArrayOf(0)) }.isInstanceOf(ProtocolCompiler.ProtocolFailure::class.java)
        assertThatThrownBy { ProtocolCompiler.assemble(spec, transactionKey = "G1", phase = "responseAck", requestFields = emptyMap()) }.hasMessageContaining("컨텍스트")
    }

    @Test fun `v2는 누락 ACK와 알 수 없는 속성 및 숫자 boolean 강제변환을 역직렬화 전에 거부한다`() {
        val mapper = jacksonObjectMapper()
        val json = mapper.valueToTree<com.fasterxml.jackson.databind.node.ObjectNode>(spec())
        assertThat(ProtocolCompiler.jsonErrors(json)).isEmpty()
        json.put("isLittleEndian", true)
        assertThat(ProtocolCompiler.jsonErrors(json).map { it.path }).contains("isLittleEndian")
        json.put("isLittleEndian", "false")
        assertThat(ProtocolCompiler.jsonErrors(json).map { it.path }).contains("isLittleEndian")
        json.put("isLittleEndian", false)
        val transaction = json.path("transactions").path(0) as com.fasterxml.jackson.databind.node.ObjectNode
        transaction.remove("requestAck"); transaction.put("heartBeat", true)
        val field = json.path("header").path(0) as com.fasterxml.jackson.databind.node.ObjectNode
        field.put("len", 1.5); field.put("signed", "false")
        assertThat(ProtocolCompiler.jsonErrors(json).map { it.path }).contains("transactions[0].requestAck", "transactions[0].heartBeat", "header[0].len", "header[0].signed")
        assertThat(ProtocolCompiler.jsonErrors(mapper.readTree("""{"header":[],"futureField":true}"""))).isEmpty()
    }

    @Test fun `큰 필드 합계가 정수 경계를 넘어도 컴파일에서 거부하며 바이트를 할당하지 않는다`() {
        val huge = List(4) { ProtocolSpec.Field("huge$it", 1 shl 30, "binary") } + ProtocolSpec.Field("tail", 30, "binary")
        val protocol = spec()
        assertThatThrownBy { ProtocolCompiler.compile(protocol.copy(header = huge)) }.isInstanceOf(ProtocolCompiler.CompileException::class.java)
        assertThatThrownBy { ProtocolCompiler.compile(protocol.copy(messages = protocol.messages!!.map { it.copy(fields = huge) })) }.isInstanceOf(ProtocolCompiler.CompileException::class.java)
        val message = ProtocolSpec.AckMessage("hugeAck", fields = huge)
        assertThat(message.length()).isEqualTo(Int.MAX_VALUE)
        assertThatThrownBy { ProtocolCompiler.compile(protocol.copy(ackMessages = listOf(message))) }.isInstanceOf(ProtocolCompiler.CompileException::class.java)
    }

    private fun await(condition: () -> Boolean) {
        val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
        while (!condition() && System.nanoTime() < until) Thread.sleep(10)
        assertThat(condition()).isTrue()
    }
}
