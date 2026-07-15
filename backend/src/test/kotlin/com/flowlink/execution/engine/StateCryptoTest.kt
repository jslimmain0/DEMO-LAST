package com.flowlink.execution.engine

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class StateCryptoTest {

    @Test
    fun roundTrip() {
        val c = StateCrypto("secret-1")
        val plain = """{"ctxValues":{"v1":{"token":"비밀값 🔒"}}}"""
        assertEquals(plain, c.decrypt(c.encrypt(plain)))
    }

    @Test
    fun differentIvPerCall() {
        val c = StateCrypto("secret-1")
        assertNotEquals(c.encrypt("x"), c.encrypt("x"))
    }

    @Test
    fun wrongKeyFails() {
        val enc = StateCrypto("secret-1").encrypt("x")
        assertThrows(Exception::class.java) { StateCrypto("secret-2").decrypt(enc) }
    }

    @Test
    fun tamperedCiphertextFails() {
        val c = StateCrypto("secret-1")
        val enc = c.encrypt("x").toCharArray()
        enc[enc.size - 3] = if (enc[enc.size - 3] == 'A') 'B' else 'A'
        assertThrows(Exception::class.java) { c.decrypt(String(enc)) }
    }

    @Test
    fun devKeyFlag() {
        assertTrue(StateCrypto(null).isDevKey)
        assertTrue(StateCrypto(" ").isDevKey)
        assertFalse(StateCrypto("k").isDevKey)
        // dev 키끼리는 상호 복호화(재시작 후에도 읽힘)
        assertEquals("y", StateCrypto(null).decrypt(StateCrypto("").encrypt("y")))
    }
}
