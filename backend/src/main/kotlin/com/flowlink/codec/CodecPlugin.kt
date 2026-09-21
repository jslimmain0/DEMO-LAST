package com.flowlink.codec

import com.flowlink.transform.FlowTransform

/**
 * 전문 코덱 플러그인 SPI — 고정길이 전문의 encode/decode 쌍. 인터페이스 종류가 곧 적용 층이다.
 *  - [FieldCodec]   : 필드 값(String) ↔ 필드 값. 송신 시 문자셋 인코딩 **전**, 수신 시 패딩 제거·디코딩 **후** 적용(개별 암호화·코드 변환).
 *  - [MessageCodec] : 본문 바이트 ↔ 본문 바이트. 헤더(길이·거래코드)는 평문 — 길이 계산 전에 적용(전체 암호화·압축).
 *  - [WireCodec]    : **직렬화가 끝난 전체 프레임**(헤더+본문) 바이트 ↔ 바이트. 송신은 길이 계산·헤더 결합 **후**, 수신은 프레이밍 직후·헤더 분리 **전**.
 *                    전문 전체를 덮는 서명/체크섬/암호화용. 범위·알고리즘은 플러그인이 정한다(엔진은 모른다).
 * JAR: 구현 클래스를 `META-INF/services/com.flowlink.codec.CodecPlugin` 에 등록(FlowTransform 과 같은 JAR 가능).
 * 필드 `len` 은 **변환 후 길이**다(AES+base64 면 그 결과 길이).
 */
interface CodecPlugin {
    fun id(): String
    fun label(): String = id()
    /** 설정 파라미터 스키마(UI 폼) — FlowTransform 과 같은 타입 재사용. */
    fun params(): List<FlowTransform.TransformParam> = emptyList()
}

interface FieldCodec : CodecPlugin {
    fun encode(value: String, ctx: CodecCtx): String
    fun decode(value: String, ctx: CodecCtx): String
}

interface MessageCodec : CodecPlugin {
    fun encode(body: ByteArray, ctx: CodecCtx): ByteArray
    fun decode(body: ByteArray, ctx: CodecCtx): ByteArray
}

interface WireCodec : CodecPlugin {
    fun encode(frame: ByteArray, ctx: CodecCtx): ByteArray
    fun decode(frame: ByteArray, ctx: CodecCtx): ByteArray
}

/** 적용 대상 필드 정보(field 층만, message 층은 null). */
data class FieldInfo(val name: String, val len: Int, val type: String, val pad: String)

/**
 * 호출 문맥 — [message] 는 같은 전문의 다른 필드 값(거래코드별 키 선택 등), [config] 는 프로토콜에 적은 파라미터,
 * [direction] 은 "send" | "recv". [messageKey]·[headerLength] 는 전체 프레임을 다루는 [WireCodec] 이 헤더/본문 경계를 알 수 있게.
 */
class CodecCtx @JvmOverloads constructor(
    val field: FieldInfo?,
    val message: Map<String, String>,
    val config: Map<String, String>,
    val direction: String,
    /** 전문 키(거래코드) — 수신 프레임을 아직 못 읽었으면 null. */
    val messageKey: String? = null,
    /** 헤더 바이트 길이 — wire 층에서 헤더/본문을 가를 때. */
    val headerLength: Int = 0,
)
