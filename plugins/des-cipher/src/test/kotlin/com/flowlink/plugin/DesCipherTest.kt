package com.flowlink.plugin

import com.flowlink.transform.FlowTransform
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.ServiceLoader

class DesCipherTest {

    private val encryptTransform = DesEncrypt()
    private val decryptTransform = DesDecrypt()

    @Test
    fun `encrypt and decrypt roundtrip with default options`() {
        val plainText = "Hello, FlowLink!"
        val key = "12345678" // 8 bytes for DES

        val encResult = encryptTransform.apply(
            inputs = mapOf("input" to plainText, "key" to key),
            config = emptyMap()
        )
        val encryptedHex = encResult["result"] ?: error("Missing result")

        val decResult = decryptTransform.apply(
            inputs = mapOf("input" to encryptedHex, "key" to key),
            config = emptyMap()
        )
        val decryptedText = decResult["result"]

        assertEquals(plainText, decryptedText)
    }

    @Test
    fun `encrypt and decrypt with pkcs5 padding and base64 output`() {
        val plainText = "Secret message with PKCS5"
        val key = "87654321"
        val config = mapOf(
            "padding" to "pkcs5",
            "output" to "base64"
        )

        val encResult = encryptTransform.apply(
            inputs = mapOf("input" to plainText, "key" to key),
            config = config
        )
        val encryptedBase64 = encResult["result"] ?: error("Missing result")

        val decResult = decryptTransform.apply(
            inputs = mapOf("input" to encryptedBase64, "key" to key),
            config = config
        )
        val decryptedText = decResult["result"]

        assertEquals(plainText, decryptedText)
    }

    @Test
    fun `verify SPI service loader discovers both transforms`() {
        val loader = ServiceLoader.load(FlowTransform::class.java)
        val transforms = loader.toList()

        val ids = transforms.map { it.id() }
        assertTrue(ids.contains("des-encrypt"), "ServiceLoader should contain des-encrypt")
        assertTrue(ids.contains("des-decrypt"), "ServiceLoader should contain des-decrypt")
    }
}
