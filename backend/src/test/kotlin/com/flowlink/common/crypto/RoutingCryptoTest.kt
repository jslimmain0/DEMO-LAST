package com.flowlink.common.crypto

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * RoutingCrypto — 쓰기는 항상 primary(Transit), 읽기는 암호문 접두사로 라우팅:
 * `vault:` 로 시작하면 Transit, 아니면 레거시(StateCrypto) 폴백 → 기존 데이터 무중단 이관.
 */
class RoutingCryptoTest {

    /** 호출 추적용 가짜 프로바이더 — prefix 를 붙였다 떼는 가역 변환. */
    private class Fake(val tag: String) : CryptoProvider {
        val decrypted = mutableListOf<String>()
        override fun encrypt(plain: String): String = "$tag:$plain"
        override fun decrypt(encoded: String): String {
            decrypted.add(encoded)
            return encoded.removePrefix("$tag:")
        }
    }

    @Test
    fun `encrypt 는 항상 primary 로 간다`() {
        val primary = Fake("vault:v1")
        val legacy = Fake("legacy")
        val crypto = RoutingCrypto(primary, legacy)
        assertThat(crypto.encrypt("hi")).isEqualTo("vault:v1:hi")
    }

    @Test
    fun `vault 접두사 암호문은 primary 로, 나머지는 legacy 로 복호화한다`() {
        val primary = Fake("vault:v1")
        val legacy = Fake("legacy")
        val crypto = RoutingCrypto(primary, legacy)

        assertThat(crypto.decrypt("vault:v1:new")).isEqualTo("new")
        assertThat(crypto.decrypt("legacy:old")).isEqualTo("old")
        assertThat(primary.decrypted).containsExactly("vault:v1:new")
        assertThat(legacy.decrypted).containsExactly("legacy:old")
    }

    @Test
    fun `decryptAll 은 혼재 목록에서도 입력 순서를 보존한다`() {
        val primary = Fake("vault:v1")
        val legacy = Fake("legacy")
        val crypto = RoutingCrypto(primary, legacy)

        val out = crypto.decryptAll(listOf("legacy:a", "vault:v1:b", "legacy:c", "vault:v1:d"))
        assertThat(out).containsExactly("a", "b", "c", "d")
    }

    @Test
    fun `isTransitFormat 은 vault 접두사를 판별한다(이관 대상 선별용)`() {
        assertThat(RoutingCrypto.isTransitFormat("vault:v1:abc")).isTrue()
        assertThat(RoutingCrypto.isTransitFormat("vault:v2:abc")).isTrue()
        assertThat(RoutingCrypto.isTransitFormat("aGVsbG8=")).isFalse()
    }
}
