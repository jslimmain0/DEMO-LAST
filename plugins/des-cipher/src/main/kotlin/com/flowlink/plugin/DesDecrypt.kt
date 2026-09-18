package com.flowlink.plugin

import com.flowlink.transform.FlowTransform

class DesDecrypt : FlowTransform {

    override fun id() = "des-decrypt"

    override fun label() = "DES 복호화"

    override fun description() =
        "DES 암호문(hex/base64)을 평문으로. 키·패딩·인코딩을 암호화와 동일하게."

    override fun inputs() = listOf(
        FlowTransform.IoSpec("input", "암호문", "string"),
        FlowTransform.IoSpec("key", "키(8바이트)", "string"),
    )

    override fun outputs() = listOf(FlowTransform.IoSpec.of("result", "평문"))

    override fun params() = listOf(
        FlowTransform.TransformParam.select("keyFormat", "키 형식", listOf("utf8", "base64", "hex"), "utf8"),
        FlowTransform.TransformParam.select("padding", "패딩", listOf("zero", "pkcs5"), "zero"),
        FlowTransform.TransformParam.select("output", "암호문 인코딩", listOf("hex", "base64"), "hex"),
    )

    override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> =
        mapOf("result" to desApply(false, inputs, config))
}