package com.flowlink.mock

import com.flowlink.common.tenant.TenantContext
import com.flowlink.common.error.BadRequestException
import com.flowlink.environment.EnvironmentService
import com.flowlink.secret.SecretService
import org.springframework.stereotype.Component
import org.springframework.http.HttpStatus
import org.springframework.web.server.ResponseStatusException

@Component
class ManagedMockScopeLoader(private val secrets: SecretService, private val environments: EnvironmentService,
    private val workspace: com.flowlink.workspace.WorkspaceService? = null,
    private val central: org.springframework.beans.factory.ObjectProvider<com.flowlink.common.host.LocalServerResources>? = null,
    private val protocols: org.springframework.beans.factory.ObjectProvider<com.flowlink.protocol.ProtocolService>? = null,
    private val json: com.flowlink.common.json.JsonService? = null,
    private val connection: org.springframework.beans.factory.ObjectProvider<com.flowlink.common.host.LocalServerConnection>? = null,
) : MockScopeLoader {
    override fun load(tenantId: String, environment: String, workspaceId: java.util.UUID?): MockSecretProvider.Scope {
        val prev = TenantContext.getTenantId()
        TenantContext.setTenantId(tenantId)
        try {
            if (!environments.exists(environment, workspaceId)) throw BadRequestException("선택한 환경이 없습니다: $environment")
            return try {
                MockSecretProvider.Scope(secrets.activeSecrets(environment.ifEmpty { null }, workspaceId), environments.vars(environment, workspaceId))
            } catch (_: Exception) {
                throw ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "환경·시크릿을 불러오지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.")
            }
        } finally { TenantContext.setTenantId(prev) }
    }

    override fun load(tenantId: String, environment: String, workspaceId: java.util.UUID?, spec: MockSpec): MockSecretProvider.Scope {
        if (spec.resourceWorkspaceId != "public") throw BadRequestException("공통 자원 공간은 public만 선택할 수 있습니다.")
        if (spec.envSource != null && spec.envSource !in setOf("local", "server")) throw BadRequestException("알 수 없는 환경 출처입니다.")
        val local = workspace?.localRuntime == true
        val source = spec.envSource ?: if (local) "local" else "server"
        val secretEnv = if (source == "local") null else environment.ifEmpty { null }
        val previous = TenantContext.getTenantId()
        TenantContext.setTenantId(tenantId)
        try {
            if (!local) {
                if (source == "local") throw BadRequestException("서버 Mock에서는 내 PC 환경을 사용할 수 없습니다.")
                val environmentScope: java.util.UUID? = null
                if (!environments.exists(environment, environmentScope)) throw BadRequestException("선택한 환경이 없습니다: $environment")
                val protocol = spec.tcp?.protocolId?.takeIf { it.isNotBlank() }?.let { protocols?.getObject()?.snapshot(it, null, null) }
                return MockSecretProvider.Scope(secrets.activeSecrets(secretEnv, null), environments.vars(environment, environmentScope), codecLookup = protocol?.plugins, protocol = protocol?.spec, protocolFingerprint = protocol?.fingerprint)
            }
            fun identity() = spec.resourceIdentity?.takeIf { it.serverUrl.isNotBlank() } ?: throw BadRequestException("Mock을 저장한 서버 연결 정보가 필요합니다.")
            fun server() = central?.getObject() ?: throw BadRequestException("중앙 Mock 연결이 준비되지 않았습니다.")
            val variables = if (source == "server") server().environment(environment.ifEmpty { null }, identity()) else {
                if (!environments.exists(environment, workspaceId)) throw BadRequestException("선택한 환경이 없습니다: $environment")
                environments.vars(environment, workspaceId)
            }
            val protocol = spec.tcp?.protocolId?.takeIf { it.isNotBlank() }?.let { protocols?.getObject()?.snapshot(it, null, identity())
                ?: throw BadRequestException("중앙 프로토콜 연결이 준비되지 않았습니다.") }
            val keys = linkedSetOf<String>()
            val mapper = json?.mapper() ?: throw BadRequestException("Mock 자원 조회가 준비되지 않았습니다.")
            fun references(value: com.fasterxml.jackson.databind.JsonNode) {
                if (value.isTextual) {
                    val matcher = com.flowlink.execution.engine.TokenResolver.tokenPattern().matcher(value.asText())
                    while (matcher.find()) if (matcher.group(3) == "secret") keys.add(matcher.group(1))
                    Regex("\\{\\{\\s*secret\\.([\\w.가-힣-]+)\\s*}}").findAll(value.asText()).forEach { keys.add(it.groupValues[1]) }
                } else if (value.isContainerNode) value.elements().forEachRemaining(::references)
            }
            references(mapper.valueToTree(spec))
            protocol?.spec?.let { references(mapper.valueToTree(it)) }
            val values = if (keys.isEmpty()) emptyMap() else server().secrets(secretEnv, keys, identity())
            val proxy by lazy { CentralMockTransforms(server(), identity()) }
            val usesCentral = source == "server" || keys.isNotEmpty() || protocol != null || (listOf(spec.codec) + spec.routesOrEmpty().map { it.codec }).any { !it?.request.isNullOrEmpty() || !it?.response.isNullOrEmpty() }
            val verify = {
                if (usesCentral) {
                    val expected = identity()
                    val active = connection?.getObject()?.connectionIdentity() ?: throw BadRequestException("Mock의 서버 연결을 확인하지 못했습니다.")
                    if (!active.connected || active.serverUrl != expected.serverUrl || active.login != expected.login) throw BadRequestException("Mock을 저장한 서버 계정에 다시 연결하세요.")
                }
            }
            verify()
            return MockSecretProvider.Scope(values, variables, transformLookup = { proxy.find(it) }, codecLookup = protocol?.plugins, protocol = protocol?.spec, verifyAccess = verify, protocolFingerprint = protocol?.fingerprint)
        } finally { TenantContext.setTenantId(previous) }
    }
}
