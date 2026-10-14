package com.flowlink.protocol

import com.flowlink.codec.CodecCtx
import com.flowlink.codec.FieldCodec
import com.flowlink.common.json.JsonService
import com.flowlink.execution.engine.SecretMasker
import com.flowlink.mock.*
import com.flowlink.transform.TransformRegistry
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.*
import org.mockito.Mockito.doReturn
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.mock.mockito.MockBean
import org.springframework.boot.test.mock.mockito.SpyBean
import org.springframework.test.context.TestPropertySource
import java.util.Base64
import java.util.UUID

@SpringBootTest
@TestPropertySource(properties = ["spring.datasource.url=jdbc:h2:mem:secretderived;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE", "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=", "spring.jpa.hibernate.ddl-auto=create-drop", "flowlink.mock.tcp.port-end=65535"])
class SecretDerivedTcpTest {
    @Autowired lateinit var protocols: ProtocolService
    @Autowired lateinit var mocks: MockServerService
    @Autowired lateinit var registry: TcpMockRegistry
    @Autowired lateinit var trials: MockTrialStore
    @Autowired lateinit var json: JsonService
    @MockBean lateinit var loader: MockScopeLoader
    @SpyBean lateinit var transforms: TransformRegistry
    private val secret = "synthetic-value"
    private val encoded = Base64.getEncoder().encodeToString(secret.toByteArray())
    private var throwing = false
    private val codec = object : FieldCodec {
        override fun id() = "synthetic-base64"
        override fun encode(value: String, ctx: CodecCtx): String {
            if (throwing) error(encoded)
            return Base64.getEncoder().encodeToString(value.toByteArray())
        }
        override fun decode(value: String, ctx: CodecCtx): String {
            if (throwing) error(encoded)
            return String(Base64.getDecoder().decode(value))
        }
    }
    @BeforeEach fun setup() {
        val transform = object : com.flowlink.transform.FlowTransform {
            override fun id() = "synthetic-base64"
            override fun label() = id()
            override fun apply(inputs: Map<String, String>, config: Map<String, String>) = mapOf("result" to Base64.getEncoder().encodeToString(inputs.getValue("input").toByteArray()))
        }
        val scope = MockSecretProvider.Scope(mapOf("KEY" to secret), emptyMap(), transformLookup = { transform })
        doReturn(scope).`when`(loader).load(anyString(), anyString(), isNull<UUID>())
        doReturn(scope).`when`(loader).load(anyString(), anyString(), isNull<UUID>(), any(MockSpec::class.java) ?: MockSpec(emptyList()))
        doReturn(codec).`when`(transforms).codec(eq(codec.id()) ?: codec.id(), isNull<UUID>(), anyString())
        doReturn("synthetic-approved").`when`(transforms).fingerprint(eq(codec.id()) ?: codec.id(), isNull<UUID>(), anyString())
    }
    private fun spec(config: String = "{}") = json.readTree("""{"schemaVersion":2,"encoding":"UTF-8","header":[{"name":"code","len":2,"type":"ascii"}],"messages":[{"key":"request","fields":[{"name":"value","len":20,"type":"ascii","plugin":{"id":"synthetic-base64","config":$config}}]},{"key":"response","fields":[{"name":"value","len":20,"type":"ascii","plugin":{"id":"synthetic-base64","config":$config}}]}],"transactions":[{"key":"payment","when":[{"field":"code","op":"eq","value":"P1"}],"requestMessage":"request","responseMessage":"response","framing":{"mode":"fixed","fixedLength":22},"responseFraming":{"mode":"fixed","fixedLength":22},"requestAck":null,"responseAck":null}]}""")
    private fun safe(value: Any?) {
        val text = json.toJson(value)
        assertFalse(text.contains(secret), text)
        assertFalse(text.contains(encoded), text)
        assertFalse(text.contains(com.flowlink.common.tcp.TcpBytes.hexDump(encoded.toByteArray())), text)
    }
    @Test fun `both secret syntaxes and resolved plaintext redact preview parse custom errors send trial and logs while wire remains original`() {
        assertTrue(SecretMasker.hasSecretReference("{{KEY@secret}}"))
        assertTrue(SecretMasker.hasSecretReference("{{secret.KEY}}"))
        val raw = spec()
        for (value in listOf("{{KEY@secret}}", "{{secret.KEY}}", secret)) {
            safe(protocols.preview(ProtocolDtos.PreviewRequest(raw, values = mapOf("value" to value), transactionKey = "payment")))
        }
        val wire = "P1$encoded".toByteArray()
        val parsed = protocols.preview(ProtocolDtos.PreviewRequest(spec("""{"key":"{{secret.KEY}}"}"""), action = "parse", transactionKey = "payment", bytesB64 = Base64.getEncoder().encodeToString(wire)))
        assertTrue(parsed.errors.isEmpty(), parsed.errors.toString()); safe(parsed)
        val decodedKnown = protocols.preview(ProtocolDtos.PreviewRequest(raw, action = "parse", transactionKey = "payment", bytesB64 = Base64.getEncoder().encodeToString(wire)))
        assertTrue(decodedKnown.errors.isEmpty(), decodedKnown.errors.toString()); safe(decodedKnown)
        throwing = true
        val failed = protocols.preview(ProtocolDtos.PreviewRequest(raw, values = mapOf("value" to secret), transactionKey = "payment"))
        assertEquals(SecretMasker.DERIVED_ERROR, failed.errors.single().message); safe(failed)
        val parseFailure = protocols.preview(ProtocolDtos.PreviewRequest(raw, action = "parse", transactionKey = "payment", bytesB64 = Base64.getEncoder().encodeToString(wire)))
        assertEquals(SecretMasker.DERIVED_ERROR, parseFailure.errors.single().message); safe(parseFailure)
        throwing = false
        val http = json.readTree("""{"codec":{"response":[{"id":"synthetic-base64","target":"body"}]},"routes":[{"id":"http","method":"GET","path":"/secret","rules":[{"id":"ok","when":[],"body":"{{secret.KEY}}","contentType":"text"}]}]}""")
        val httpPreview = mocks.preview(MockDtos.PlanRequest(type = "HTTP", spec = http, request = json.readTree("""{"method":"GET","path":"/secret"}""")))
        assertEquals("***", (httpPreview["response"] as Map<*, *>)["body"]); safe(httpPreview)
        val p = protocols.create("secret-${UUID.randomUUID()}", raw)
        val slug = "secret-${UUID.randomUUID().toString().take(8)}"
        val port = registry.pickFreePort(19550)
        val mock = mocks.upsert(MockDtos.PlanRequest(name = slug, slug = slug, type = "TCP", enabled = true, spec = json.readTree("""{"tcp":{"port":$port,"protocolId":"${p.id}","rules":[{"id":"ok","then":{"mode":"mock","fields":{"value":"{{secret.KEY}}"}}}]}}""")))
        try {
            safe(mocks.preview(MockDtos.PlanRequest(slug = slug, request = json.readTree("""{"key":"request","values":{"value":"public"}}"""))))
            val sent = mocks.tcpSend(mock.id, MockDtos.TcpSendRequest(transactionKey = "payment", values = mapOf("value" to "public")))
            assertEquals("SUCCEEDED", sent.transportStatus); safe(sent); safe(trials.get(sent.executionId!!)); safe(mocks.tcpLog(mock.id))
            val spec = protocols.specOf(p.id)
            val actual = TcpClient.exchange("127.0.0.1", port, 2000, "P1cHVibGlj            ".toByteArray(), spec, plugins = ProtocolCodec.PluginLookup { codec })
            assertEquals("P1$encoded", String(actual.response.bytes))
        } finally { mocks.delete(mock.id); protocols.delete(p.id) }
    }
}
