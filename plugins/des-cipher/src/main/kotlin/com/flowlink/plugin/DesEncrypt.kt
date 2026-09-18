package com.flowlink.plugin

import com.flowlink.transform.FlowTransform

class DesEncrypt : FlowTransform {

    override fun id() = "des-encrypt"

    override fun label() = "DES 암호화"

    override fun description() =
        "평문을 DES(ECB)로 암호화 → hex/base64. 키는 입력 포트(시크릿 바인딩 권장). 레거시 호환용 zero 패딩이 기본."

    override fun inputs() = listOf(
        FlowTransform.IoSpec("input", "평문", "string"),
        FlowTransform.IoSpec("key", "키(8바이트)", "string"),
    )

    override fun outputs() = listOf(FlowTransform.IoSpec.of("result", "암호문"))

    override fun params() = listOf(
        FlowTransform.TransformParam.select("keyFormat", "키 형식", listOf("utf8", "base64", "hex"), "utf8"),
        FlowTransform.TransformParam.select("padding", "패딩", listOf("zero", "pkcs5"), "zero"),
        FlowTransform.TransformParam.select("output", "암호문 인코딩", listOf("hex", "base64"), "hex"),
    )

    override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> =
        mapOf("result" to desApply(true, inputs, config))
}