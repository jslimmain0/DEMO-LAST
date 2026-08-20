package com.flowlink.common.crypto

import com.flowlink.secret.VaultProperties
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.jsonPath
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withServerError
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient
import java.util.Base64

/**
 * TransitCrypto — Vault Transit(encrypt/decrypt/{key})로 암복호화를 위임하는 CryptoProvider.
 * 평문은 base64 로 실어 보내고, 암호문은 vault:v1:... 형식을 그대로 저장한다.
 */
class TransitCryptoTest {

    private fun props() = VaultProperties(
        enabled = true, address = "http://vault.test:8200", token = "tkn",
        mount = null, path = null, configPath = null, refreshSeconds = null,
        transit = VaultProperties.Transit(enabled = true, mount = "transit", key = "flowlink-kek"),
    )

    private fun b64(s: String): String = Base64.getEncoder().encodeToString(s.toByteArray(Charsets.UTF_8))

    @Test
    fun `encrypt 는 transit encrypt 엔드포인트에 base64 평문을 보내고 ciphertext 를 돌려준다`() {
        val builder = RestClient.builder()
        val server = MockRestServiceServer.bindTo(builder).build()
        server.expect(requestTo("http://vault.test:8200/v1/transit/encrypt/flowlink-kek"))
            .andExpect(method(HttpMethod.POST))
            .andExpect(header("X-Vault-Token", "tkn"))
            .andExpect(jsonPath("$.plaintext").value(b64("s3cret")))
            .andRespond(withSuccess("""{"data":{"ciphertext":"vault:v1:AbC"}}""", MediaType.APPLICATION_JSON))

        val crypto = TransitCrypto(props(), builder)
        assertThat(crypto.encrypt("s3cret")).isEqualTo("vault:v1:AbC")
        server.verify()
    }

    @Test
    fun `decrypt 는 transit decrypt 엔드포인트에 ciphertext 를 보내고 base64 평문을 푼다`() {
        val builder = RestClient.builder()
        val server = MockRestServiceServer.bindTo(builder).build()
        server.expect(requestTo("http://vault.test:8200/v1/transit/decrypt/flowlink-kek"))
            .andExpect(method(HttpMethod.POST))
            .andExpect(jsonPath("$.ciphertext").value("vault:v1:AbC"))
            .andRespond(withSuccess("""{"data":{"plaintext":"${b64("s3cret")}"}}""", MediaType.APPLICATION_JSON))

        val crypto = TransitCrypto(props(), builder)
        assertThat(crypto.decrypt("vault:v1:AbC")).isEqualTo("s3cret")
        server.verify()
    }

    @Test
    fun `decryptAll 은 batch_input 한 번의 호출로 여러 건을 순서대로 푼다`() {
        val builder = RestClient.builder()
        val server = MockRestServiceServer.bindTo(builder).build()
        server.expect(requestTo("http://vault.test:8200/v1/transit/decrypt/flowlink-kek"))
            .andExpect(method(HttpMethod.POST))
            .andExpect(jsonPath("$.batch_input[0].ciphertext").value("vault:v1:AAA"))
            .andExpect(jsonPath("$.batch_input[1].ciphertext").value("vault:v1:BBB"))
            .andRespond(
                withSuccess(
                    """{"data":{"batch_results":[{"plaintext":"${b64("one")}"},{"plaintext":"${b64("two")}"}]}}""",
                    MediaType.APPLICATION_JSON
                )
            )

        val crypto = TransitCrypto(props(), builder)
        assertThat(crypto.decryptAll(listOf("vault:v1:AAA", "vault:v1:BBB"))).containsExactly("one", "two")
        server.verify()
    }

    @Test
    fun `decryptAll 빈 목록은 Vault 호출 없이 빈 결과`() {
        val builder = RestClient.builder()
        val server = MockRestServiceServer.bindTo(builder).build()
        val crypto = TransitCrypto(props(), builder)
        assertThat(crypto.decryptAll(emptyList())).isEmpty()
        server.verify() // 기대 요청 0건 — 호출이 있었으면 실패
    }

    @Test
    fun `Vault 오류는 예외로 전파된다(조용한 무시 금지)`() {
        val builder = RestClient.builder()
        val server = MockRestServiceServer.bindTo(builder).build()
        server.expect(requestTo("http://vault.test:8200/v1/transit/decrypt/flowlink-kek"))
            .andRespond(withServerError())

        val crypto = TransitCrypto(props(), builder)
        assertThatThrownBy { crypto.decrypt("vault:v1:AbC") }.isInstanceOf(Exception::class.java)
    }

    @Test
    fun `배치 응답의 항목 오류는 예외로 전파된다`() {
        val builder = RestClient.builder()
        val server = MockRestServiceServer.bindTo(builder).build()
        server.expect(requestTo("http://vault.test:8200/v1/transit/decrypt/flowlink-kek"))
            .andRespond(
                withSuccess(
                    """{"data":{"batch_results":[{"plaintext":"${b64("one")}"},{"error":"invalid ciphertext"}]}}""",
                    MediaType.APPLICATION_JSON
                )
            )

        val crypto = TransitCrypto(props(), builder)
        assertThatThrownBy { crypto.decryptAll(listOf("vault:v1:AAA", "vault:v1:BAD")) }
            .hasMessageContaining("invalid ciphertext")
    }
}
