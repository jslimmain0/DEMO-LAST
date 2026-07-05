package com.flowlink.core.graph

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/** 고정길이 TCP 응답 전문에서 잘라낼 출력 필드(바이트 단위). */
@JsonIgnoreProperties(ignoreUnknown = true)
data class TcpRespField(
    val id: String?,
    val name: String?,
    val length: Int?,
    val encoding: String?
) {
    fun lengthOrZero(): Int = length ?: 0
}
