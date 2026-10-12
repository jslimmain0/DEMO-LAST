package com.flowlink.protocol

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import java.security.MessageDigest
import java.util.HexFormat

/** 서버와 PC의 Jackson 설정·bean 탐색 순서와 무관한 전문/승인 코덱 버전 계약. */
object ProtocolFingerprint {
    private val canonical = jacksonObjectMapper()
        .configure(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY, true)
        .configure(MapperFeature.SORT_CREATOR_PROPERTIES_FIRST, false)
        .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true)
        .configure(SerializationFeature.INDENT_OUTPUT, false)
        .setSerializationInclusion(JsonInclude.Include.ALWAYS)

    fun of(spec: ProtocolSpec, codecs: Map<String, String>): String {
        val bytes = canonical.writeValueAsBytes(mapOf("spec" to spec, "codecs" to codecs))
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))
    }
}
