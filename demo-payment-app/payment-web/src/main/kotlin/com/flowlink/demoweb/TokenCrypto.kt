package com.flowlink.demoweb

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object TokenCrypto {
    // 가맹점: AES-256-GCM, IV 12바이트, 태그 16바이트, AAD 없음.
    // wire: base64url(IV).base64url(ciphertext).base64url(tag), '=' 패딩 없음.
    // 발급 요청은 평문 JSON. 결제 화면 진입 시에만 토큰을 복호화한다.
    fun decrypt(encryptedToken: String, key: ByteArray): String {
        require(encryptedToken.length <= 1024)
        val parts = encryptedToken.split('.')
        require(parts.size == 3 && parts.all { it.matches(Regex("[A-Za-z0-9_-]+")) })
        val (iv, ciphertext, tag) = parts.map { Base64.getUrlDecoder().decode(it) }
        require(iv.size == 12 && tag.size == 16)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        return cipher.doFinal(ciphertext + tag).toString(Charsets.UTF_8)
    }
}
