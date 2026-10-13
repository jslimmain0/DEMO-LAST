package com.flowlink.protocol

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

class ProtocolFingerprintTest {
    private val spec = ProtocolSpec(encoding = "UTF-8", lengthField = "length", includesSelf = true,
        header = listOf(ProtocolSpec.Field("length", 4, "length")),
        messages = listOf(ProtocolSpec.Message("request", fields = listOf(ProtocolSpec.Field("value", 32, "string",
            plugin = ProtocolSpec.PluginRef("field", linkedMapOf("z" to "last", "a" to "first")))))),
        messagePlugins = listOf(ProtocolSpec.PluginRef("message", linkedMapOf("suffix" to "B", "prefix" to "A"))))

    @Test fun `전송 옵션 없는 기존 명세는 추가 전 fingerprint를 유지한다`() {
        assertEquals("3261904084a5c0463a8e86c18dc8d66c0eedf49c8b7cb2a304754e2fc4c18e1c",
            ProtocolFingerprint.of(spec, mapOf("field" to "field-v1", "message" to "message-v1")))
        val json = jacksonObjectMapper().setSerializationInclusion(JsonInclude.Include.ALWAYS).valueToTree<com.fasterxml.jackson.databind.JsonNode>(spec)
        assertEquals(false, json.has("framing"))
        assertEquals(false, json.has("responseFraming"))
        assertEquals(false, json.has("transport"))
        assertNotEquals(ProtocolFingerprint.of(spec, emptyMap()), ProtocolFingerprint.of(spec.copy(transport = ProtocolSpec.Transport("execution")), emptyMap()))
    }

    @Test fun `서로 다른 호스트 JSON 순서 null 생략과 pretty 출력도 같은 전문 버전을 만든다`() {
        val first = jacksonObjectMapper().configure(SerializationFeature.INDENT_OUTPUT, true)
            .configure(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY, false).setSerializationInclusion(JsonInclude.Include.NON_NULL)
        val second = jacksonObjectMapper().configure(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY, true)
            .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true)
        val bytes = first.writeValueAsBytes(spec)
        val transported = second.readValue(bytes, ProtocolSpec::class.java)
        val hash = ProtocolFingerprint.of(spec, linkedMapOf("field" to "field-v1", "message" to "message-v1"))
        assertEquals(hash, ProtocolFingerprint.of(transported, linkedMapOf("message" to "message-v1", "field" to "field-v1")))
        val reordered = second.valueToTree<com.fasterxml.jackson.databind.JsonNode>(transported)
        val config = reordered.path("messages").path(0).path("fields").path(0).path("plugin").path("config") as com.fasterxml.jackson.databind.node.ObjectNode
        config.removeAll(); config.put("a", "first"); config.put("z", "last")
        assertEquals(hash, ProtocolFingerprint.of(second.treeToValue(reordered, ProtocolSpec::class.java), mapOf("field" to "field-v1", "message" to "message-v1")))
        assertNotEquals(hash, ProtocolFingerprint.of(transported.copy(encoding = "EUC-KR"), mapOf("field" to "field-v1", "message" to "message-v1")))
        assertNotEquals(hash, ProtocolFingerprint.of(transported, mapOf("field" to "field-v2", "message" to "message-v1")))
    }

    @Test fun `computed getter와 필드 순서가 뒤집힌 실제 JSON도 변조 없이 복원한다`() {
        val mapper = jacksonObjectMapper()
        val original = mapper.valueToTree<com.fasterxml.jackson.databind.JsonNode>(spec)
        val properties = original.fieldNames().asSequence().toList()
        val binary = properties.firstOrNull { it.endsWith("binaryLength", ignoreCase = true) }
        val little = properties.firstOrNull { it.endsWith("littleEndian", ignoreCase = true) }
        assertEquals(false, binary?.let { original[it].asBoolean() }, properties.toString())
        assertEquals(false, little?.let { original[it].asBoolean() }, properties.toString())
        val reverse = mapper.createObjectNode()
        original.fieldNames().asSequence().toList().reversed().forEach { reverse.set<com.fasterxml.jackson.databind.JsonNode>(it, original[it]) }
        val reconstructed = mapper.treeToValue(reverse, ProtocolSpec::class.java)
        assertEquals(ProtocolFingerprint.of(spec, mapOf("field" to "v1")), ProtocolFingerprint.of(reconstructed, mapOf("field" to "v1")))
    }
}
