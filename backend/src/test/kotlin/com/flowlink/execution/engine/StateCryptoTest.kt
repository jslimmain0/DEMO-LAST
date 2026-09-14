package com.flowlink.execution.engine

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
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
}
