package com.flowlink.mock

import com.flowlink.execution.engine.MockUrlResolver
import org.springframework.stereotype.Component
import java.util.UUID

@Component
class ManagedMockUrlResolver(private val mocks: MockServerService) : MockUrlResolver {
    override fun normalize(url: String, workspaceId: UUID?) = mocks.normalizeLegacyUrl(url, workspaceId)
}
