package com.flowlink.protocol

import java.util.UUID

/** 실행에 필요한 규격과 승인된 코덱만 제공한다. 저장소와 접근 권한은 호스트가 관리한다. */
interface ProtocolResources {
    fun spec(reference: String, workspaceId: UUID? = null): ProtocolSpec
    fun plugins(workspaceId: UUID? = null): ProtocolCodec.PluginLookup
}
