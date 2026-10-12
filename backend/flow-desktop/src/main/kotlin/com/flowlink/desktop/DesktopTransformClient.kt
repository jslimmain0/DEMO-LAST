package com.flowlink.desktop

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.agent.CentralResourceIdentity
import com.flowlink.common.host.CentralTransformDescriptor
import com.flowlink.common.host.CentralTransformRequest
import com.flowlink.common.host.CentralTransformResult
import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Component
import java.time.Duration

@Component
@Profile("desktop")
class DesktopTransformClient(private val connection: DesktopConnection, private val mapper: ObjectMapper) {
    private val catalogType = object : TypeReference<List<CentralTransformDescriptor>>() {}
    fun transforms(identity: CentralResourceIdentity): List<CentralTransformDescriptor> = mapper.convertValue(
        connection.authenticatedJson("GET", "/api/v1/agent/central-transforms/catalog", expectedServer = identity.serverUrl, expectedLogin = identity.login, timeout = Duration.ofSeconds(30)), catalogType)
    fun transform(request: CentralTransformRequest, identity: CentralResourceIdentity): CentralTransformResult = mapper.treeToValue(
        connection.authenticatedJson("POST", "/api/v1/agent/central-transforms/invoke", mapper.valueToTree(request), identity.serverUrl, identity.login, timeout = Duration.ofSeconds(30)), CentralTransformResult::class.java)
}
