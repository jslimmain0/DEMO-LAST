package com.flowlink.agent

import java.util.UUID

/** 실행 위치의 자원 공급 계약. DB·Vault·권한 검사는 공급하는 호스트가 담당한다. */
interface AgentResources {
    val localRuntime: Boolean
    fun workspaceScope(reference: String?): UUID?
    fun environmentExists(name: String?, scope: UUID?): Boolean
    fun environment(name: String?, scope: UUID?): Map<String, String>
    fun secrets(name: String?, scope: UUID?): Map<String, String>
    fun mockTarget(reference: String, scope: UUID?): AgentMockTarget
    fun protocolFingerprint(reference: String, scope: UUID?): String
    fun centralEnvironment(name: String?, identity: CentralResourceIdentity): Map<String, String> =
        throw com.flowlink.common.error.BadRequestException("중앙 환경을 사용할 수 없습니다.")
    fun centralSecrets(name: String?, keys: Set<String>, identity: CentralResourceIdentity): Map<String, String> =
        throw com.flowlink.common.error.BadRequestException("중앙 시크릿을 사용할 수 없습니다.")
    fun centralProtocolFingerprint(reference: String, identity: CentralResourceIdentity): String =
        throw com.flowlink.common.error.BadRequestException("중앙 프로토콜을 사용할 수 없습니다.")
    fun centralProtocolSecretKeys(reference: String, identity: CentralResourceIdentity): Set<String> =
        throw com.flowlink.common.error.BadRequestException("중앙 프로토콜의 시크릿 참조를 확인하지 못했습니다.")
}

data class AgentMockTarget(val baseUrl: String, val tcpHost: String?, val tcpPort: Int?)
