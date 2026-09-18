package com.flowlink.plugin

import java.nio.charset.StandardCharsets
import java.util.*
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

private const val DES_PAD_BYTE: Byte = 0

internal fun desApply(encrypt: Boolean, inputs: Map<String, String>, config: Map<String, String>): String {
    val keyBytes = decodeBytes(inputs["key"] ?: "", config.getOrDefault("keyFormat", "utf8"))
    require(keyBytes.size == 8) { "DES 키는 8바이트여야 합니다(현재 ${keyBytes.size}). keyFormat 을 확인하세요." }
    val zeroPad = config.getOrDefault("padding", "zero").lowercase() != "pkcs5"
    val cipher = Cipher.getInstance(if (zeroPad) "DES/ECB/NoPadding" else "DES/ECB/PKCS5Padding")
    cipher.init(if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "DES"))
    val enc = config.getOrDefault("output", "hex")
    return if (encrypt) {
        val plain = (inputs["input"] ?: "").toByteArray(StandardCharsets.UTF_8)
        val data = if (zeroPad) plain.copyOf(desPaddedSize(plain.size)) else plain
        encodeBytes(cipher.doFinal(data), enc)
    } else {
        val raw = decodeBytes(inputs["input"] ?: "", enc)
        require(raw.isNotEmpty() && raw.size % 8 == 0) { "DES 암호문은 8바이트의 배수여야 합니다(현재 ${raw.size}). 암호문 인코딩을 확인하세요." }
        val out = cipher.doFinal(raw)
        String(if (zeroPad) trimTrailingPad(out) else out, StandardCharsets.UTF_8)
    }
}

private fun decodeBytes(value: String, format: String): ByteArray = when (format.lowercase()) {
    "base64" -> Base64.getDecoder().decode(value)
    "hex" -> value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    else -> value.toByteArray(StandardCharsets.UTF_8)
}

private fun encodeBytes(bytes: ByteArray, format: String): String = when (format.lowercase()) {
    "base64" -> Base64.getEncoder().encodeToString(bytes)
    else -> bytes.joinToString("") { "%02x".format(it) }
}

private fun desPaddedSize(size: Int): Int = if (size % 8 == 0) size else size + 8 - (size % 8)

private fun trimTrailingPad(bytes: ByteArray): ByteArray {
    var end = bytes.size
    while (end > 0 && bytes[end - 1] == DES_PAD_BYTE) end--
    return bytes.copyOf(end)
}