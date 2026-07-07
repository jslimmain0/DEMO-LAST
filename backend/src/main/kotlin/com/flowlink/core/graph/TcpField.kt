package com.flowlink.core.graph

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * 고정길이 TCP 전문의 요청 필드 한 개(바이트 단위).
 *
 * @param length  바이트 길이(고정). 인코딩에 따라 한글은 2바이트 등.
 * @param value   리터럴 값(토큰 포함 가능). bound 가 있으면 무시.
 * @param bound   상위 노드 값 바인딩.
 * @param pad     'left' | 'right' (정렬/패딩 방향). 보통 숫자=left(0), 문자=right(공백).
 * @param padChar 패딩 문자(기본 공백). 1글자.
 * @param encoding 필드별 인코딩 오버라이드(없으면 노드 인코딩).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class TcpField(
    val id: String?,
    val name: String?,
    val length: Int?,
    val value: String?,
    val bound: Binding?,
    val pad: String?,
    val padChar: String?,
    val encoding: String?
) {
    fun lengthOrZero(): Int = length ?: 0
}
