package com.flowlink.core.graph

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/** 고정길이 TCP 응답 전문에서 잘라낼 출력 필드(바이트 단위). */
@JsonIgnoreProperties(ignoreUnknown = true)
data class TcpRespField(
    val id: String?,
    val name: String?,
    val length: Int?,
    val encoding: String?,
    /** 슬라이스 후 패딩 제거 — 문자=후행 공백, 숫자=선행 0·공백. null(레거시)=false. */
    val trim: Boolean? = null,
    /** "string"(기본) | "number" — number 면 숫자 원형(Long/Double)으로 출력해 조건식 숫자 비교가 된다. */
    val type: String? = null,
) {
    fun lengthOrZero(): Int = length ?: 0
}
