package com.flowlink.plugin.sample

import com.flowlink.transform.FlowTransform
import com.flowlink.transform.FlowTransform.IoSpec
import com.flowlink.transform.FlowTransform.TransformParam
import java.nio.charset.StandardCharsets
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * HMAC-SHA256 서명 — 결제/인증 게이트웨이의 요청 서명·위변조 검증용.
 * 출력이 2개(hex/base64)인 멀티 출력 플러그인 예시 — 선언한 outputs 의 key 로 결과를 담아 반환하면
 * 하위 노드에서 {{ hex@노드 }} / {{ base64@노드 }} 로 각각 바인딩된다.
 */
class HmacSha256Transform : FlowTransform {

    override fun id(): String = "hmac-sha256"

    override fun label(): String = "HMAC-SHA256 서명(플러그인)"

    override fun inputs(): List<IoSpec> = listOf(IoSpec.of("input", "서명할 문자열"))

    override fun outputs(): List<IoSpec> = listOf(
        IoSpec.of("hex", "서명(16진수)"),
        IoSpec.of("base64", "서명(Base64)"),
    )

    override fun params(): List<TransformParam> = listOf(
        TransformParam.of("secret", "비밀 키"),
    )

    override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> {
        val data = inputs["input"] ?: ""
        val secret = config["secret"] ?: ""
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
        val sig = mac.doFinal(data.toByteArray(StandardCharsets.UTF_8))
        return mapOf(
            "hex" to sig.joinToString("") { "%02x".format(it) },
            "base64" to Base64.getEncoder().encodeToString(sig),
        )
    }
}
