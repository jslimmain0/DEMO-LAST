package com.flowlink.common.host

import com.flowlink.agent.CentralResourceIdentity
import com.flowlink.codec.FieldInfo
import com.flowlink.protocol.ProtocolSpec

data class CentralCodecDescriptor(val id: String, val label: String, val layer: String, val fingerprint: String)
data class CentralCodecRequest(
    val id: String, val operation: String, val fingerprint: String,
    val value: String? = null, val bytesBase64: String? = null,
    val field: FieldInfo? = null, val message: Map<String, String> = emptyMap(),
    val config: Map<String, String> = emptyMap(), val direction: String,
)
data class CentralCodecResult(val value: String? = null, val bytesBase64: String? = null)
data class CentralProtocolSnapshot(val spec: ProtocolSpec, val codecs: List<CentralCodecDescriptor>, val fingerprint: String)

/** 로그인된 PC 실행기만 사용하는 중앙 자원 연결. 개인 DB에는 복제하지 않는다. */
interface LocalServerResources {
    fun environment(name: String?, identity: CentralResourceIdentity): Map<String, String> =
        throw IllegalStateException("서버 환경 연결이 준비되지 않았습니다.")
    fun secrets(name: String?, keys: Set<String>, identity: CentralResourceIdentity): Map<String, String> =
        throw IllegalStateException("서버 시크릿 연결이 준비되지 않았습니다.")
    fun protocolSpec(reference: String, identity: CentralResourceIdentity): ProtocolSpec =
        throw IllegalStateException("서버 프로토콜 연결이 준비되지 않았습니다.")
    fun protocolFingerprint(reference: String, identity: CentralResourceIdentity): String =
        throw IllegalStateException("서버 프로토콜 연결이 준비되지 않았습니다.")
    fun protocolSnapshot(reference: String, identity: CentralResourceIdentity): CentralProtocolSnapshot =
        throw IllegalStateException("서버 프로토콜 연결이 준비되지 않았습니다.")
    fun codecs(identity: CentralResourceIdentity): List<CentralCodecDescriptor> =
        throw IllegalStateException("서버 코덱 연결이 준비되지 않았습니다.")
    fun codec(request: CentralCodecRequest, identity: CentralResourceIdentity): CentralCodecResult =
        throw IllegalStateException("서버 코덱 연결이 준비되지 않았습니다.")
    fun transforms(identity: CentralResourceIdentity): List<CentralTransformDescriptor> =
        throw IllegalStateException("서버 변환 연결이 준비되지 않았습니다.")
    fun transform(request: CentralTransformRequest, identity: CentralResourceIdentity): CentralTransformResult =
        throw IllegalStateException("서버 변환 연결이 준비되지 않았습니다.")
}
