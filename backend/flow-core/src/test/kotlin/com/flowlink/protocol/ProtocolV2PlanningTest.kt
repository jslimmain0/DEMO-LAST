package com.flowlink.protocol

import com.flowlink.assistant.TcpV2Guide
import com.flowlink.common.json.JsonService
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.core.repository.ProtocolRepository
import com.flowlink.mock.MockDtos
import com.flowlink.mock.MockRuntimeStore
import com.flowlink.mock.MockServerService
import com.flowlink.mock.MockTrialStore
import com.flowlink.mock.TcpMockRegistry
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.TestPropertySource
import java.util.UUID

@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:v2planning;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop", "flowlink.mock.tcp.port-end=65535",
])
class ProtocolV2PlanningTest {
    @Autowired lateinit var protocols: ProtocolService
    @Autowired lateinit var mocks: MockServerService
    @Autowired lateinit var json: JsonService
    @Autowired lateinit var protocolRepo: ProtocolRepository
    @Autowired lateinit var mockRepo: MockServerRepository
    @Autowired lateinit var registry: TcpMockRegistry
    @Autowired lateinit var store: MockRuntimeStore
    @Autowired lateinit var trials: MockTrialStore
    private fun name() = "v2-${UUID.randomUUID()}"

    @Test fun `published minimal protocol compiles and assemble parse preserves bytes without a definition write`() {
        val raw = json.readTree(TcpV2Guide.PROTOCOL_EXAMPLE)
        val before = protocolRepo.count()
        val report = protocols.validate(raw)
        assertTrue(report.valid, report.errors.toString())
        assertEquals(2, report.schemaVersion)
        assertTrue(report.requiredCapabilities.contains("transactionFraming"))
        val assembled = protocols.preview(ProtocolDtos.PreviewRequest(raw, transactionKey = "auth", values = mapOf("tid" to "000000001", "phone" to "01000000000")))
        assertTrue(assembled.errors.isEmpty(), assembled.errors.toString())
        assertEquals(23, assembled.wireLength)
        val parsed = protocols.preview(ProtocolDtos.PreviewRequest(raw, transactionKey = "auth", action = "parse", bytesB64 = assembled.bytesB64))
        assertTrue(parsed.errors.isEmpty(), parsed.errors.toString())
        assertEquals(assembled.hex, parsed.hex)
        assertEquals(before, protocolRepo.count())
        val incomplete = protocols.preview(ProtocolDtos.PreviewRequest(raw, transactionKey = "auth", action = "parse", bytesB64 = "RjE="))
        assertEquals("FRAME_LENGTH_MISMATCH", incomplete.errors.single().code)
        val missing = raw.deepCopy<com.fasterxml.jackson.databind.node.ObjectNode>()
        (missing.path("transactions").path(0) as com.fasterxml.jackson.databind.node.ObjectNode).remove("requestAck")
        assertEquals("transactions[0].requestAck", protocols.validate(missing).errors.single().path)
        val unknown = raw.deepCopy<com.fasterxml.jackson.databind.node.ObjectNode>()
        (unknown.path("transactions").path(0) as com.fasterxml.jackson.databind.node.ObjectNode).put("unsupportedFraming", true)
        assertEquals("transactions[0].unsupportedFraming", protocols.validate(unknown).errors.single().path)
    }

    @Test fun `HTTP preview shares runtime matching but does not change state sequence hits or definition versions`() {
        val slug = "preview-${UUID.randomUUID().toString().take(8)}"
        val mock = mocks.create(MockDtos.CreateMockServerRequest(name(), slug))
        try {
            val spec = json.readTree("""{"routes":[{"id":"pay","method":"POST","path":"/pay","rules":[{"id":"once","repeat":1,"when":[],"body":"{{seq}}/{{body.tid}}","contentType":"text","status":200,"setState":[{"key":"done","value":"yes"}],"callback":{"url":"http://127.0.0.1:1/callback"}}]}]}""")
            mocks.updateSpec(mock.id, spec)
            val before = store.snapshot(mock.id)
            val version = mocks.get(mock.id).currentVersion
            val count = mockRepo.count()
            val request = json.readTree("""{"method":"POST","path":"/pay","body":{"tid":"synthetic"}}""")
            repeat(2) {
                val result = mocks.preview(MockDtos.PlanRequest(slug = slug, request = request))
                assertEquals(false, result["sideEffects"])
                assertEquals("once", result["ruleId"])
                assertEquals(true, result["callbackPlanned"])
                assertEquals("1001/synthetic", (result["response"] as Map<*, *>)["body"])
            }
            assertEquals(before, store.snapshot(mock.id))
            assertEquals(version, mocks.get(mock.id).currentVersion)
            assertEquals(count, mockRepo.count())
        } finally { mocks.delete(mock.id) }
    }

    @Test fun `v2 TCP preview and actual send choose same transaction and trial preserves original definition`() {
        val protocol = protocols.create(name(), json.readTree(TcpV2Guide.PROTOCOL_EXAMPLE))
        val slug = "preview-${UUID.randomUUID().toString().take(8)}"
        val port = registry.pickFreePort(19510)
        val raw = json.readTree("""{"tcp":{"port":$port,"protocolId":"${protocol.id}","rules":[{"id":"success","when":[{"field":"code","op":"eq","value":"F1"}],"then":{"mode":"mock","fields":{"result":"00","phone":"{{req.phone}}"}}}]}}""")
        val initialMocks = mockRepo.count()
        val checked = mocks.validate(MockDtos.PlanRequest(slug = slug, type = "TCP", spec = raw))
        assertTrue(checked.valid, checked.errors.toString())
        assertEquals(initialMocks, mockRepo.count())
        val mock = mocks.upsert(MockDtos.PlanRequest(name = name(), slug = slug, type = "TCP", spec = raw, enabled = true))
        try {
            val before = store.snapshot(mock.id)
            val input = mapOf("tid" to "000000001", "phone" to "01000000000")
            val request = json.mapper().valueToTree<com.fasterxml.jackson.databind.JsonNode>(mapOf("key" to "F1:request", "values" to input))
            val preview = mocks.preview(MockDtos.PlanRequest(slug = slug, request = request))
            assertEquals("auth", preview["transactionKey"])
            assertEquals(before, store.snapshot(mock.id))
            assertEquals(mock.currentVersion, mocks.get(mock.id).currentVersion)
            val invalid = raw.deepCopy<com.fasterxml.jackson.databind.node.ObjectNode>()
            (invalid.path("tcp").path("rules").path(0).path("when").path(0) as com.fasterxml.jackson.databind.node.ObjectNode).put("op", "unsupported")
            assertEquals("tcp.rules[0].when[0].op", mocks.validate(MockDtos.PlanRequest(type = "TCP", spec = invalid)).errors.single().path)
            val sent = mocks.tcpSend(mock.id, MockDtos.TcpSendRequest(values = input, transactionKey = "auth"))
            assertEquals("SUCCEEDED", sent.transportStatus)
            assertEquals("auth", sent.transactionKey)
            assertEquals(25, sent.response.bytes)
            assertEquals((preview["response"] as Map<*, *>)["hex"], sent.response.hex)
            assertEquals("COMPLETE", sent.steps.last().phase)
            assertNotNull(sent.executionId)
            val trial = trials.get(sent.executionId!!)!!
            assertEquals(mock.currentVersion, trial["definitionVersion"])
            assertEquals(protocols.fingerprint(protocol.id.toString()), trial["protocolFingerprint"])
            assertEquals("SUCCEEDED", trial["status"])
            assertTrue((trial["retention"] as String).contains("재시작"))
            assertThrows(com.flowlink.common.error.BadRequestException::class.java) {
                mocks.tcpSend(mock.id, MockDtos.TcpSendRequest(values = input, transactionKey = "auth", executionId = sent.executionId))
            }
        } finally { mocks.delete(mock.id); protocols.delete(protocol.id) }
    }

    @Test fun `legacy preview plans fixed HEX ACK phases instead of skipping them`() {
        val protocol = protocols.create(name(), json.readTree("""{"encoding":"UTF-8","header":[{"name":"prefix","len":1,"type":"ascii"}],"messages":[{"key":"request","fields":[{"name":"value","len":1,"type":"ascii"}]},{"key":"response","fields":[{"name":"value","len":1,"type":"ascii"}]}],"framing":{"mode":"fixed","fixedLength":2},"transport":{"requestAckHex":"06","responseAckHex":"15"}}"""))
        try {
            val raw = json.readTree("""{"tcp":{"port":19520,"protocolId":"${protocol.id}","rules":[{"id":"ok","then":{"mode":"mock","fields":{"value":"Y"}}}]}}""")
            val request = json.readTree("""{"key":"request","values":{"prefix":"X","value":"A"}}""")
            val result = mocks.preview(MockDtos.PlanRequest(type = "TCP", spec = raw, request = request))
            val steps = result["steps"] as List<*>
            for (index in listOf(1, 3)) {
                val ack = steps[index] as Map<*, *>
                assertEquals("PLANNED", ack["status"])
                assertEquals(1, ack["expectedBytes"])
                assertEquals("exact", ack["validationMode"])
            }
        } finally { protocols.delete(protocol.id) }
    }
}
