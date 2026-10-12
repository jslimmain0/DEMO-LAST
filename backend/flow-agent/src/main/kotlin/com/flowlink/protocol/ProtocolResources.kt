package com.flowlink.protocol

import java.util.UUID

data class ResolvedProtocol(val spec: ProtocolSpec, val plugins: ProtocolCodec.PluginLookup, val fingerprint: String? = null)

/** 실행에 필요한 규격과 승인된 코덱만 제공한다. 저장소와 접근 권한은 호스트가 관리한다. */
interface ProtocolResources {
    fun spec(reference: String, workspaceId: UUID? = null): ProtocolSpec
    fun plugins(workspaceId: UUID? = null): ProtocolCodec.PluginLookup

    fun spec(reference: String, workspaceId: UUID?, resourceIdentity: com.flowlink.agent.CentralResourceIdentity?): ProtocolSpec =
        spec(reference, workspaceId)
    fun plugins(workspaceId: UUID?, resourceIdentity: com.flowlink.agent.CentralResourceIdentity?): ProtocolCodec.PluginLookup =
        plugins(workspaceId)
    fun snapshot(reference: String, workspaceId: UUID?, resourceIdentity: com.flowlink.agent.CentralResourceIdentity?): ResolvedProtocol =
        ResolvedProtocol(spec(reference, workspaceId, resourceIdentity), plugins(workspaceId, resourceIdentity))
}
