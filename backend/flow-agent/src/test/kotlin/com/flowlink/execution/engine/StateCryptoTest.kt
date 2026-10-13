package com.flowlink.execution.engine

import com.flowlink.common.error.BadRequestException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class StateCryptoTest {

    @Test
    fun roundTrip() {
        val c = StateCrypto()
        val plain = """{"ctxValues":{"v1":{"token":"비밀값 🔒"}}}"""
        assertEquals(plain, c.decrypt(c.encrypt(plain)))
    }

    @Test
    fun differentIvPerCall() {
        val c = StateCrypto()
        assertNotEquals(c.encrypt("x"), c.encrypt("x"))
    }

    @Test
    fun tamperedCiphertextFails() {
        val c = StateCrypto()
        val enc = c.encrypt("x").toCharArray()
        enc[enc.size - 3] = if (enc[enc.size - 3] == 'A') 'B' else 'A'
        assertThrows(Exception::class.java) { c.decrypt(String(enc)) }
    }

    @Test
    fun mismatchedKeyFails() {
        val encrypted = StateCrypto("first-local-key").encrypt("private value")
        assertThrows(javax.crypto.AEADBadTagException::class.java) { StateCrypto("other-local-key").decrypt(encrypted) }
    }

    @Test
    fun vaultCiphertextRequiresTransitWithoutExposingValueOrKey() {
        val key = "synthetic-local-key"
        val c = StateCrypto(key)
        val ciphertext = "vault:v1:fake"
        val error = assertThrows(BadRequestException::class.java) { c.decrypt(ciphertext) }
        assertTrue(error.message.orEmpty().contains("Vault Transit 설정이 필요"))
        assertTrue(error.message.orEmpty().contains("API 전송용 Base64"))
        assertFalse(error.message.orEmpty().contains(ciphertext))
        assertFalse(error.message.orEmpty().contains(key))
        val batchError = assertThrows(BadRequestException::class.java) { c.decryptAll(listOf(c.encrypt("local value"), ciphertext)) }
        assertEquals(error.message, batchError.message)
    }
}
