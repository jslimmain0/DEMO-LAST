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
}

data class AgentMockTarget(val baseUrl: String, val tcpHost: String?, val tcpPort: Int?)
