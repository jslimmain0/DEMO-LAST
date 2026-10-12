package com.flowlink.desktop

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.agent.CentralResourceIdentity
import com.flowlink.common.host.CentralCodecDescriptor
import com.flowlink.common.host.CentralCodecRequest
import com.flowlink.common.host.CentralCodecResult
import com.flowlink.common.host.CentralProtocolSnapshot
import com.flowlink.protocol.ProtocolSpec
import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Component
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Duration

/** 로그인 시점의 서버/계정으로 고정한 실행 전용 호출. 개인 DB와 브라우저 프록시를 거치지 않는다. */
@Component
@Profile("desktop")
class DesktopProtocolClient(private val connection: DesktopConnection, private val mapper: ObjectMapper) {
    private val catalogType = object : TypeReference<List<CentralCodecDescriptor>>() {}
    private fun encodedReference(value: String) = URLEncoder.encode(value, StandardCharsets.UTF_8)
    private fun get(path: String, identity: CentralResourceIdentity) = connection.authenticatedJson("GET", path,
        expectedServer = identity.serverUrl, expectedLogin = identity.login, timeout = Duration.ofSeconds(30))

    fun protocolSpec(reference: String, identity: CentralResourceIdentity): ProtocolSpec =
        mapper.treeToValue(get("/api/v1/agent/central-protocols/spec?reference=${encodedReference(reference)}", identity), ProtocolSpec::class.java)
    fun protocolFingerprint(reference: String, identity: CentralResourceIdentity): String =
        get("/api/v1/agent/central-protocols/fingerprint?reference=${encodedReference(reference)}", identity).path("fingerprint").asText()
            .takeIf { it.isNotBlank() } ?: throw IllegalStateException("서버 프로토콜 버전 응답이 올바르지 않습니다.")
    fun protocolSnapshot(reference: String, identity: CentralResourceIdentity): CentralProtocolSnapshot =
        mapper.treeToValue(get("/api/v1/agent/central-protocols/snapshot?reference=${encodedReference(reference)}", identity), CentralProtocolSnapshot::class.java)
    fun codecs(identity: CentralResourceIdentity): List<CentralCodecDescriptor> =
        mapper.convertValue(get("/api/v1/agent/central-codecs/catalog", identity), catalogType)
    fun codec(request: CentralCodecRequest, identity: CentralResourceIdentity): CentralCodecResult = mapper.treeToValue(
        connection.authenticatedJson("POST", "/api/v1/agent/central-codecs/invoke", mapper.valueToTree(request),
            identity.serverUrl, identity.login, timeout = Duration.ofSeconds(30)), CentralCodecResult::class.java)
}
