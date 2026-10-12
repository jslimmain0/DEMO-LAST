package com.flowlink.desktop

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.agent.CentralResourceIdentity
import com.flowlink.common.host.LocalServerResources
import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Component
import java.time.Duration

@Component
@Profile("desktop")
class DesktopCentralResources(private val connection: DesktopConnection, private val mapper: ObjectMapper,
    private val protocols: DesktopProtocolClient, private val transforms: DesktopTransformClient) : LocalServerResources {
    private val mapType = object : TypeReference<Map<String, String>>() {}

    private fun values(name: String?, variables: Boolean, keys: Set<String>, identity: CentralResourceIdentity): com.fasterxml.jackson.databind.JsonNode {
        val body = mapper.createObjectNode().apply {
            put("environment", name); put("variables", variables)
            set<com.fasterxml.jackson.databind.JsonNode>("secretNames", mapper.valueToTree(keys))
        }
        return connection.authenticatedJson("POST", "/api/v1/agent/resources", body,
            identity.serverUrl, identity.login, timeout = Duration.ofSeconds(30))
    }

    override fun environment(name: String?, identity: CentralResourceIdentity): Map<String, String> =
        mapper.convertValue(values(name, true, emptySet(), identity).get("vars"), mapType)

    override fun secrets(name: String?, keys: Set<String>, identity: CentralResourceIdentity): Map<String, String> =
        if (keys.isEmpty()) emptyMap() else mapper.convertValue(values(name, false, keys, identity).get("secrets"), mapType)

    override fun protocolSpec(reference: String, identity: CentralResourceIdentity) = protocols.protocolSpec(reference, identity)
    override fun protocolSnapshot(reference: String, identity: CentralResourceIdentity) = protocols.protocolSnapshot(reference, identity)
    override fun protocolFingerprint(reference: String, identity: CentralResourceIdentity) = protocols.protocolFingerprint(reference, identity)
    override fun codecs(identity: CentralResourceIdentity) = protocols.codecs(identity)
    override fun codec(request: com.flowlink.common.host.CentralCodecRequest, identity: CentralResourceIdentity) = protocols.codec(request, identity)
    override fun transforms(identity: CentralResourceIdentity) = transforms.transforms(identity)
    override fun transform(request: com.flowlink.common.host.CentralTransformRequest, identity: CentralResourceIdentity) = transforms.transform(request, identity)
}
