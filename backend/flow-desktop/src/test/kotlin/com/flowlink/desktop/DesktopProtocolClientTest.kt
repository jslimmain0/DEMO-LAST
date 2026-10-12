package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.agent.CentralResourceIdentity
import com.flowlink.common.host.CentralCodecRequest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Duration

class DesktopProtocolClientTest {
    @Test fun `정의와 코덱 RPC는 시작한 서버 계정을 고정하고 binary와 원문을 그대로 전달한다`() {
        val connection = mock(DesktopConnection::class.java)
        val mapper = jacksonObjectMapper()
        val client = DesktopProtocolClient(connection, mapper)
        val identity = CentralResourceIdentity("https://central.example", "alice")
        val reference = "결제 공통/1"
        val query = URLEncoder.encode(reference, StandardCharsets.UTF_8)
        val timeout = Duration.ofSeconds(30)
        val specPath = "/api/v1/agent/central-protocols/spec?reference=$query"
        val hashPath = "/api/v1/agent/central-protocols/fingerprint?reference=$query"
        val snapshotPath = "/api/v1/agent/central-protocols/snapshot?reference=$query"
        val catalogPath = "/api/v1/agent/central-codecs/catalog"
        val invokePath = "/api/v1/agent/central-codecs/invoke"
        `when`(connection.authenticatedJson("GET", specPath, null, identity.serverUrl, identity.login, emptyMap(), timeout))
            .thenReturn(mapper.readTree("""{"encoding":"UTF-8"}"""))
        `when`(connection.authenticatedJson("GET", hashPath, null, identity.serverUrl, identity.login, emptyMap(), timeout))
            .thenReturn(mapper.readTree("""{"fingerprint":"version1"}"""))
        `when`(connection.authenticatedJson("GET", snapshotPath, null, identity.serverUrl, identity.login, emptyMap(), timeout))
            .thenReturn(mapper.readTree("""{"spec":{"encoding":"UTF-8"},"codecs":[{"id":"codec","label":"서버 승인본","layer":"message","fingerprint":"version1"}],"fingerprint":"snapshot-version"}"""))
        `when`(connection.authenticatedJson("GET", catalogPath, null, identity.serverUrl, identity.login, emptyMap(), timeout))
            .thenReturn(mapper.readTree("""[{"id":"codec","label":"서버 승인본","layer":"message","fingerprint":"version1"}]"""))
        val request = CentralCodecRequest("codec", "decode", "version1", bytesBase64 = "AAH/gA==",
            config = mapOf("key" to "secret-plain"), direction = "recv")
        val body = mapper.valueToTree<com.fasterxml.jackson.databind.JsonNode>(request)
        `when`(connection.authenticatedJson("POST", invokePath, body, identity.serverUrl, identity.login, emptyMap(), timeout))
            .thenReturn(mapper.readTree("""{"bytesBase64":"AAH/gA=="}"""))
        assertThat(client.protocolSpec(reference, identity).encoding).isEqualTo("UTF-8")
        assertThat(client.protocolFingerprint(reference, identity)).isEqualTo("version1")
        assertThat(client.protocolSnapshot(reference, identity).codecs.single().fingerprint).isEqualTo("version1")
        assertThat(client.codecs(identity).single().layer).isEqualTo("message")
        assertThat(client.codec(request, identity).bytesBase64).isEqualTo(request.bytesBase64)
        verify(connection).authenticatedJson("GET", specPath, null, identity.serverUrl, identity.login, emptyMap(), timeout)
        verify(connection).authenticatedJson("GET", hashPath, null, identity.serverUrl, identity.login, emptyMap(), timeout)
        verify(connection).authenticatedJson("GET", snapshotPath, null, identity.serverUrl, identity.login, emptyMap(), timeout)
        verify(connection).authenticatedJson("GET", catalogPath, null, identity.serverUrl, identity.login, emptyMap(), timeout)
        verify(connection).authenticatedJson("POST", invokePath, body, identity.serverUrl, identity.login, emptyMap(), timeout)
    }
}
