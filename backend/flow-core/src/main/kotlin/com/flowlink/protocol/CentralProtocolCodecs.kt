package com.flowlink.protocol

import com.flowlink.agent.CentralResourceIdentity
import com.flowlink.codec.CodecCtx
import com.flowlink.codec.CodecPlugin
import com.flowlink.codec.FieldCodec
import com.flowlink.codec.MessageCodec
import com.flowlink.common.host.CentralCodecDescriptor
import com.flowlink.common.host.CentralCodecRequest
import com.flowlink.common.host.CentralCodecResult
import com.flowlink.common.host.LocalServerResources
import java.util.Base64

/** 실행 한 번의 승인 버전을 고정하고, 코덱 구현은 중앙 서버에서만 호출한다. */
internal class CentralProtocolCodecs(private val server: LocalServerResources, private val identity: CentralResourceIdentity) {
    fun lookup(descriptors: List<CentralCodecDescriptor> = server.codecs(identity)): ProtocolCodec.PluginLookup {
        val codecs = descriptors.associate { it.id to proxy(it) }
        return ProtocolCodec.PluginLookup { codecs[it] }
    }

    private fun invoke(descriptor: CentralCodecDescriptor, operation: String, ctx: CodecCtx, value: String? = null, bytes: ByteArray? = null): CentralCodecResult =
        server.codec(CentralCodecRequest(descriptor.id, operation, descriptor.fingerprint, value,
            bytes?.let { Base64.getEncoder().encodeToString(it) }, ctx.field, ctx.message, ctx.config, ctx.direction), identity)

    private fun proxy(descriptor: CentralCodecDescriptor): CodecPlugin = when (descriptor.layer) {
        "field" -> object : FieldCodec {
            override fun id() = descriptor.id
            override fun label() = descriptor.label
            override fun encode(value: String, ctx: CodecCtx): String = field("encode", value, ctx)
            override fun decode(value: String, ctx: CodecCtx): String = field("decode", value, ctx)
            private fun field(operation: String, value: String, ctx: CodecCtx): String =
                invoke(descriptor, operation, ctx, value = value).value
                    ?: throw IllegalStateException("서버 필드 코덱 응답이 올바르지 않습니다.")
        }
        "message" -> object : MessageCodec {
            override fun id() = descriptor.id
            override fun label() = descriptor.label
            override fun encode(body: ByteArray, ctx: CodecCtx): ByteArray = message("encode", body, ctx)
            override fun decode(body: ByteArray, ctx: CodecCtx): ByteArray = message("decode", body, ctx)
            private fun message(operation: String, body: ByteArray, ctx: CodecCtx): ByteArray =
                invoke(descriptor, operation, ctx, bytes = body).bytesBase64?.let { Base64.getDecoder().decode(it) }
                    ?: throw IllegalStateException("서버 메시지 코덱 응답이 올바르지 않습니다.")
        }
        else -> throw IllegalStateException("서버 코덱 종류가 올바르지 않습니다: ${descriptor.id}")
    }
}
