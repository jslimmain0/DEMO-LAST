package com.flowlink.common.crypto

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.flowlink.secret.VaultProperties
import org.springframework.http.client.SimpleClientHttpRequestFactory
import org.springframework.web.client.RestClient
import java.util.Base64

/**
 * Vault Transit 봉투 암호화 — 암복호화를 `POST {vault}/v1/{mount}/encrypt|decrypt/{key}` 로 위임한다.
 * KEK 는 Vault 밖으로 나오지 않고, 앱은 base64 평문/`vault:v1:...` 암호문만 주고받는다.
 * 오류는 예외로 전파한다(호출부가 실행 실패 처리 — 조용한 폴백 금지).
 */
class TransitCrypto(
    private val props: VaultProperties,
    private val tokens: com.flowlink.secret.VaultTokenSource = com.flowlink.secret.VaultTokenSource.of(props),
    builder: RestClient.Builder = RestClient.builder().requestFactory(
        SimpleClientHttpRequestFactory().apply { setConnectTimeout(3000); setReadTimeout(3000) }
    ),
) : CryptoProvider {

    private val client: RestClient = builder.baseUrl(props.address).build()

    override fun encrypt(plain: String): String {
        val b64 = Base64.getEncoder().encodeToString(plain.toByteArray(Charsets.UTF_8))
        val resp = post("encrypt", mapOf("plaintext" to b64))
        return resp?.data?.ciphertext ?: throw IllegalStateException("Vault Transit encrypt 응답에 ciphertext 없음")
    }

    override fun decrypt(encoded: String): String {
        val resp = post("decrypt", mapOf("ciphertext" to encoded))
        val b64 = resp?.data?.plaintext ?: throw IllegalStateException("Vault Transit decrypt 응답에 plaintext 없음")
        return String(Base64.getDecoder().decode(b64), Charsets.UTF_8)
    }

    /** batch_input 한 번의 호출로 N건 복호화(실행당 Vault 왕복 1회). 항목 오류는 예외로 전파. */
    override fun decryptAll(values: List<String>): List<String> {
        if (values.isEmpty()) return emptyList()
        val resp = post("decrypt", mapOf("batch_input" to values.map { mapOf("ciphertext" to it) }))
        val results = resp?.data?.batchResults ?: throw IllegalStateException("Vault Transit batch 응답에 batch_results 없음")
        if (results.size != values.size) {
            throw IllegalStateException("Vault Transit batch 결과 수 불일치: ${results.size} != ${values.size}")
        }
        return results.map { r ->
            if (r.error != null) throw IllegalStateException("Vault Transit batch 항목 오류: ${r.error}")
            val b64 = r.plaintext ?: throw IllegalStateException("Vault Transit batch 항목에 plaintext 없음")
            String(Base64.getDecoder().decode(b64), Charsets.UTF_8)
        }
    }

    private fun post(op: String, body: Map<String, Any>): TransitResponse? =
        client.post()
            .uri("/v1/{mount}/{op}/{key}", props.transit.mount, op, props.transit.key)
            .header("X-Vault-Token", tokens.token())
            .body(body)
            .retrieve()
            .body(TransitResponse::class.java)

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class TransitResponse(val data: Data?) {
        @JsonIgnoreProperties(ignoreUnknown = true)
        data class Data(
            val ciphertext: String? = null,
            val plaintext: String? = null,
            @com.fasterxml.jackson.annotation.JsonProperty("batch_results")
            val batchResults: List<BatchResult>? = null,
        )

        @JsonIgnoreProperties(ignoreUnknown = true)
        data class BatchResult(val plaintext: String? = null, val ciphertext: String? = null, val error: String? = null)
    }
}
