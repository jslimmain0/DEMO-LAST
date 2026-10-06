package com.flowlink.agent

import com.flowlink.common.error.BadRequestException
import com.flowlink.environment.EnvironmentService
import com.flowlink.mock.MockServerService
import com.flowlink.protocol.ProtocolService
import com.flowlink.secret.SecretService
import com.flowlink.workspace.WorkspaceService
import org.springframework.stereotype.Component
import java.util.UUID

/** 개인 호스트는 H2, 공용 호스트는 서버 저장소의 자원만 공급한다. */
@Component
class ManagedAgentResources(
    private val workspace: WorkspaceService,
    private val environments: EnvironmentService,
    private val secretService: SecretService,
    private val mocks: MockServerService,
    private val protocols: ProtocolService,
) : AgentResources {
    override val localRuntime: Boolean get() = workspace.localRuntime
    override fun workspaceScope(reference: String?): UUID? {
        val scope = workspace.resolveId(if (localRuntime) null else reference ?: "public")
        if (!workspace.supportsWorkspace(scope)) throw BadRequestException("목적지 워크스페이스가 실행 에이전트와 다릅니다.")
        return scope
    }
    override fun environmentExists(name: String?, scope: UUID?) = environments.exists(name, scope)
    override fun environment(name: String?, scope: UUID?) = environments.vars(name, scope)
    override fun secrets(name: String?, scope: UUID?) = secretService.activeSecrets(name, scope)
    override fun mockTarget(reference: String, scope: UUID?) = mocks.resolveAgentTarget(reference, scope).let {
        AgentMockTarget(it.baseUrl, it.tcpHost, it.tcpPort)
    }
    override fun protocolFingerprint(reference: String, scope: UUID?) = protocols.fingerprint(reference, scope)
}
