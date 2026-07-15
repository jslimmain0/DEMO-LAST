package com.flowlink.execution.engine

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * suspension run_state 암호화(AES-256-GCM) — ctx 에는 SET 시크릿이 **비마스킹**으로 들어 있어
 * DB 영속 시 평문 노출을 막는다(redaction deny-by-default 정책과 정합).
 *
 * 키 = SHA-256(secret). secret 미설정 시 dev 고정키([DEV_SECRET]) — 로컬 개발 편의용이며
 * OIDC(공유) 모드에선 ExecutionService 가 기동 시 WARN 을 남긴다. 포맷: base64(iv(12) || ciphertext+tag).
 */
class StateCrypto(secret: String?) {

    val isDevKey: Boolean = secret.isNullOrBlank()
    private val key = SecretKeySpec(
        MessageDigest.getInstance("SHA-256").digest((secret?.ifBlank { null } ?: DEV_SECRET).toByteArray(Charsets.UTF_8)),
        "AES"
    )
    private val random = SecureRandom()

    fun encrypt(plain: String): String {
        val iv = ByteArray(IV_LEN).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(iv + ct)
    }

    /** 복호화 — 키 불일치/변조 시 AEADBadTagException 등 예외를 그대로 던진다(호출부가 실패 처리). */
    fun decrypt(encoded: String): String {
        val raw = Base64.getDecoder().decode(encoded)
        require(raw.size > IV_LEN) { "암호문이 너무 짧습니다" }
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, raw.copyOfRange(0, IV_LEN)))
        return String(cipher.doFinal(raw.copyOfRange(IV_LEN, raw.size)), Charsets.UTF_8)
    }

    companion object {
        private const val TRANSFORM = "AES/GCM/NoPadding"
        private const val IV_LEN = 12
        private const val TAG_BITS = 128
        private const val DEV_SECRET = "flowlink-dev-insecure-state-key"
    }
}
