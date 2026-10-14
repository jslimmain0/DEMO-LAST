package com.flowlink.common.host

import com.flowlink.protocol.Framer
import org.springframework.core.env.Environment
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Instant
import java.util.Properties

/** Queried on the executing host; the distribution manifest is never an installed-version report. */
@RestController
class RuntimeCapabilitiesController(private val environment: Environment, private val workspace: com.flowlink.workspace.WorkspaceService) {
    @GetMapping("/api/v1/runtime/capabilities")
    fun capabilities(): Map<String, Any?> {
        val props = Properties().apply { RuntimeCapabilitiesController::class.java.getResourceAsStream("/flowlink-release.properties")?.use(::load) }
        return mapOf(
            "available" to true, "installedVersion" to props.getProperty("version", "unknown"),
            "schemaVersions" to com.flowlink.protocol.ProtocolCapabilities.schemaVersions, "checkedAt" to Instant.now(),
            "features" to com.flowlink.protocol.ProtocolCapabilities.features,
            "limits" to mapOf("maxWireBytes" to Framer.MAX_FRAME, "maxAckBytes" to 1024, "minIdleTimeoutMs" to 1000, "maxIdleTimeoutMs" to 3600000,
                "tcpPortStart" to if (workspace.localRuntime) 1024 else environment.getProperty("flowlink.mock.tcp.port-start", Int::class.java, 9091),
                "tcpPortEnd" to if (workspace.localRuntime) 65535 else environment.getProperty("flowlink.mock.tcp.port-end", Int::class.java, 9190))
        )
    }
}
