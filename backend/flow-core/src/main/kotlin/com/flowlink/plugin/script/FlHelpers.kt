package com.flowlink.plugin.script

import com.flowlink.common.text.NowTokens
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.graalvm.polyglot.Value
import org.graalvm.polyglot.proxy.ProxyArray
import org.graalvm.polyglot.proxy.ProxyExecutable
import org.graalvm.polyglot.proxy.ProxyObject
import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Security
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.HexFormat
import java.util.UUID
import java.util.zip.CRC32
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/** `fl.*` 한 함수의 문서 — 편집기 자동완성·MCP 가이드가 같은 목록을 쓴다. */
data class FlApiEntry(val path: String, val signature: String, val doc: String, val example: String)

/**
 * 스크립트에 주입되는 `fl` 객체 — 전부 Graal 프록시(ProxyObject/ProxyExecutable)라 호스트 리플렉션 경로가 없다.
 * 기본값 = 회사 관례(UTF-8 · 블록 암호는 CBC/PKCS5Padding · 출력 base64). 다른 조합은 옵션 객체
 * `{ mode, padding, out, charset, as, aad, tagBits }` 로만. 바이트는 JS 쪽 배열(Uint8Array 또는 fl 이 돌려준 배열) ↔ 여기 ByteArray.
 * 잘못된 인자는 ScriptError(스크립트 오류로 표면화).
 */
object FlHelpers {
    init { if (Security.getProvider("BC") == null) Security.addProvider(BouncyCastleProvider()) }

    private val rnd = SecureRandom()

    fun build(logs: MutableList<String>): ProxyObject = obj(
        "b64" to obj(
            "enc" to fn { a -> val o = opt(a, 1); if (flag(o, "url")) b64url(bytesArg(a, 0, cs(o))) else b64(bytesArg(a, 0, cs(o))) },
            "dec" to fn { a -> val o = opt(a, 1); out(if (flag(o, "url")) b64urlDec(str(a, 0)) else Base64.getDecoder().decode(str(a, 0).trim()), o) },
        ),
        "hex" to obj("enc" to fn { a -> hex(bytesArg(a, 0, cs(opt(a, 1)))) }, "dec" to fn { a -> out(HexFormat.of().parseHex(str(a, 0).trim()), opt(a, 1)) }),
        "hash" to obj(
            "md5" to digest("MD5"), "sha1" to digest("SHA-1"), "sha224" to digest("SHA-224"), "sha256" to digest("SHA-256"),
            "sha384" to digest("SHA-384"), "sha512" to digest("SHA-512"), "sha3_256" to digest("SHA3-256"), "sha3_512" to digest("SHA3-512"),
        ),
        "hmac" to obj(
            "md5" to hmac("HmacMD5"), "sha1" to hmac("HmacSHA1"), "sha256" to hmac("HmacSHA256"),
            "sha384" to hmac("HmacSHA384"), "sha512" to hmac("HmacSHA512"),
        ),
        "pbkdf2" to fn { a ->
            val o = opt(a, 4)
            val alg = "PBKDF2WithHmac" + optStr(o, "alg", "SHA256").uppercase().replace("-", "")
            val spec = PBEKeySpec(str(a, 0).toCharArray(), bytesArg(a, 1, Charsets.UTF_8), num(a, 2, 10_000), num(a, 3, 256))
            encoded(SecretKeyFactory.getInstance(alg).generateSecret(spec).encoded, o, "hex")
        },
        "aes" to cipherNs("AES"), "seed" to cipherNs("SEED"), "aria" to cipherNs("ARIA"), "des" to cipherNs("DES"), "des3" to cipherNs("DES3"),
        "rsa" to obj(
            "sign" to fn { a -> encoded(rsaSign(str(a, 0), bytesArg(a, 1, cs(opt(a, 2))), optStr(opt(a, 2), "alg", "SHA256withRSA")), opt(a, 2), "b64") },
            "verify" to fn { a ->
                val key = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(pem(str(a, 0), "PUBLIC KEY")))
                Signature.getInstance(optStr(opt(a, 3), "alg", "SHA256withRSA")).apply { initVerify(key); update(bytesArg(a, 1, cs(opt(a, 3)))) }
                    .verify(decodeEncoded(str(a, 2), opt(a, 3), "b64"))
            },
            "encrypt" to fn { a -> encoded(rsaCipher(a, Cipher.ENCRYPT_MODE).doFinal(bytesArg(a, 1, cs(opt(a, 2)))), opt(a, 2), "b64") },
            "decrypt" to fn { a -> String(rsaCipher(a, Cipher.DECRYPT_MODE).doFinal(decodeEncoded(str(a, 1), opt(a, 2), "b64")), cs(opt(a, 2))) },
            "encryptBytes" to fn { a -> u8(rsaCipher(a, Cipher.ENCRYPT_MODE).doFinal(bytesArg(a, 1, Charsets.UTF_8))) },
            "decryptBytes" to fn { a -> u8(rsaCipher(a, Cipher.DECRYPT_MODE).doFinal(bytesArg(a, 1, Charsets.UTF_8))) },
        ),
        "ec" to obj(
            "sign" to fn { a ->
                val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pem(str(a, 0), "PRIVATE KEY")))
                val sig = Signature.getInstance(optStr(opt(a, 2), "alg", "SHA256withECDSA")).apply { initSign(key); update(bytesArg(a, 1, cs(opt(a, 2)))) }.sign()
                encoded(sig, opt(a, 2), "b64")
            },
            "verify" to fn { a ->
                val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(pem(str(a, 0), "PUBLIC KEY")))
                Signature.getInstance(optStr(opt(a, 3), "alg", "SHA256withECDSA")).apply { initVerify(key); update(bytesArg(a, 1, cs(opt(a, 3)))) }
                    .verify(decodeEncoded(str(a, 2), opt(a, 3), "b64"))
            },
        ),
        "jwt" to obj(
            "sign" to fn { a ->
                val ctx = a[0]
                val alg = optStr(opt(a, 2), "alg", "HS256").uppercase()
                val header = opt(a, 2)?.getMember("header")?.takeIf { !it.isNull }?.let { jsonOf(it) } ?: """{"alg":"$alg","typ":"JWT"}"""
                val input = b64url(header.toByteArray(Charsets.UTF_8)) + "." + b64url(jsonOf(ctx).toByteArray(Charsets.UTF_8))
                "$input." + b64url(jwtSign(alg, input.toByteArray(Charsets.US_ASCII), a))
            },
            "verify" to fn { a -> jwtVerify(str(a, 0), a) },
            "decode" to fn { a ->
                val p = str(a, 0).split('.')
                if (p.size < 2) throw ScriptError(null, null, "fl.jwt: 토큰 형식이 아닙니다(header.payload.signature)")
                val parse = a[0].context.eval("js", "JSON.parse")
                obj("header" to parse.execute(String(b64urlDec(p[0]), Charsets.UTF_8)), "payload" to parse.execute(String(b64urlDec(p[1]), Charsets.UTF_8)))
            },
        ),
        "crc32" to fn { a -> checksum(CRC32().apply { update(bytesArg(a, 0, cs(opt(a, 1)))) }.value, 8, opt(a, 1)) },
        "crc16" to fn { a -> checksum(crc16(bytesArg(a, 0, cs(opt(a, 1))), optStr(opt(a, 1), "variant", "ccitt").lowercase()).toLong(), 4, opt(a, 1)) },
        "bcc" to fn { a -> checksum(bytesArg(a, 0, cs(opt(a, 1))).fold(0) { acc, b -> acc xor (b.toInt() and 0xff) }.toLong(), 2, opt(a, 1)) },
        "lrc" to fn { a -> checksum(((256 - (bytesArg(a, 0, cs(opt(a, 1))).sumOf { it.toInt() and 0xff } and 0xff)) and 0xff).toLong(), 2, opt(a, 1)) },
        "random" to obj(
            "bytes" to fn { a -> u8(ByteArray(num(a, 0, 16)).also { rnd.nextBytes(it) }) },
            "hex" to fn { a -> hex(ByteArray(num(a, 0, 16)).also { rnd.nextBytes(it) }) },
            "b64" to fn { a -> b64(ByteArray(num(a, 0, 16)).also { rnd.nextBytes(it) }) },
        ),
        "uuid" to fn { UUID.randomUUID().toString() },
        "gzip" to obj(
            "compress" to fn { a ->
                val bo = ByteArrayOutputStream()
                GZIPOutputStream(bo).use { it.write(bytesArg(a, 0, cs(opt(a, 1)))) }
                if (opt(a, 1) != null && optStr(opt(a, 1), "out", "") != "") encoded(bo.toByteArray(), opt(a, 1), "b64") else u8(bo.toByteArray())
            },
            "decompress" to fn { a -> out(GZIPInputStream(bytesArg(a, 0, Charsets.UTF_8).inputStream()).use { it.readBytes() }, opt(a, 1)) },
        ),
        "bytes" to fn { a -> u8(str(a, 0).toByteArray(charset(str(a, 1)))) },
        "text" to fn { a -> String(bytesArg(a, 0, Charsets.UTF_8), charset(str(a, 1))) },
        "pad" to obj("left" to padFn(true), "right" to padFn(false)),
        "mask" to fn { a ->
            val s = str(a, 0); val front = num(a, 1, 0); val back = num(a, 2, 0); val ch = str(a, 3).ifEmpty { "*" }.first()
            if (front + back >= s.length) ch.toString().repeat(s.length) else s.substring(0, front) + ch.toString().repeat(s.length - front - back) + s.substring(s.length - back)
        },
        "now" to fn { a ->
            val pattern = str(a, 0); val zone = str(a, 1).ifBlank { null }
            NowTokens.resolve(if (pattern.isBlank()) "now" else "now:$pattern", zone) ?: throw ScriptError(null, null, "fl.now: 잘못된 패턴/타임존 — '$pattern' / '$zone'")
        },
        "json" to obj(
            "parse" to fn { a -> a[0].context.eval("js", "JSON.parse").execute(str(a, 0)) },
            "stringify" to fn { a -> jsonOf(a[0]) },
        ),
        "log" to fn { a -> logs.add(a.joinToString(" ") { show(it) }); null },
    )

    // ---- 프록시 빌더 ----
    private fun obj(vararg m: Pair<String, Any>): ProxyObject = ProxyObject.fromMap(mapOf(*m))
    internal fun fn(body: (Array<Value>) -> Any?): ProxyExecutable = ProxyExecutable { args ->
        try { body(args) } catch (e: ScriptError) { throw e } catch (e: Exception) { throw ScriptError(null, null, "fl: ${e.message ?: e.toString()}", e) }
    }
    private fun digest(alg: String) = fn { a -> encoded(MessageDigest.getInstance(alg).digest(bytesArg(a, 0, cs(opt(a, 1)))), opt(a, 1), "hex") }
    private fun hmac(alg: String) = fn { a ->
        val mac = Mac.getInstance(alg).apply { init(SecretKeySpec(bytesArg(a, 0, Charsets.UTF_8), alg)) }
        encoded(mac.doFinal(bytesArg(a, 1, cs(opt(a, 2)))), opt(a, 2), "hex")
    }
    private fun padFn(left: Boolean) = fn { a ->
        val s = str(a, 0); val len = num(a, 1, 0); val ch = str(a, 2).ifEmpty { " " }; val cs = cs(opt(a, 3))
        val fill = ch.toByteArray(cs); val raw = s.toByteArray(cs)
        if (raw.size >= len) s else { val padBytes = ByteArray(len - raw.size) { fill[it % fill.size] }; String(if (left) padBytes + raw else raw + padBytes, cs) }
    }

    /**
     * 대칭키 공용(AES · SEED · ARIA · DES · DES3=DESede) — `encrypt/decrypt`(문자열) · `encryptBytes/decryptBytes`(바이트).
     * 옵션 `{ mode, padding, out, charset, aad, tagBits }`:
     *  - mode: `CBC`(기본) · `ECB` · `CTR` · `CFB` · `OFB` · `GCM`(128비트 블록 = AES/SEED/ARIA 만). ECB 는 IV 무시, 그 외는 블록 크기 IV(GCM 은 12B 권장).
     *  - padding: `pkcs5`(기본) · `zero`(레거시 — NoPadding + 0x00 채움/꼬리 제거) · `none`. 스트림 모드(CTR/CFB/OFB)와 GCM 은 항상 NoPadding.
     *  - GCM: 암호문 뒤에 인증 태그(tagBits, 기본 128)가 붙고 `aad`(문자열/바이트)까지 같아야 복호화된다.
     * 키·IV 는 문자열(UTF-8 바이트) 또는 바이트 배열(`fl.hex.dec(k, { as: 'bytes' })` 로 hex/base64 키). DES3 키 16B 는 K1K2K1 로 확장.
     */
    private fun cipherNs(alg: String): ProxyObject {
        val jce = if (alg == "DES3") "DESede" else alg
        val name = "fl.${alg.lowercase()}"
        val keySizes = when (alg) { "SEED" -> listOf(16); "DES" -> listOf(8); "DES3" -> listOf(16, 24); else -> listOf(16, 24, 32) }
        val block = if (alg == "DES" || alg == "DES3") 8 else 16
        val bc = alg == "SEED" || alg == "ARIA"
        fun mode(a: Array<Value>) = optStr(opt(a, 3), "mode", "CBC").uppercase()
        fun stream(m: String) = m == "CTR" || m == "CFB" || m == "OFB" || m == "GCM"
        fun zero(a: Array<Value>) = !stream(mode(a)) && optStr(opt(a, 3), "padding", "pkcs5").lowercase() == "zero"
        fun cipher(a: Array<Value>, dir: Int): Cipher {
            val o = opt(a, 3); val m = mode(a)
            var key = bytesArg(a, 1, Charsets.UTF_8)
            if (key.size !in keySizes) throw ScriptError(null, null, "$name: 키는 ${keySizes.joinToString("/")}바이트여야 합니다(현재 ${key.size})")
            if (alg == "DES3" && key.size == 16) key += key.copyOf(8) // 2키 3DES(K1K2) → K1K2K1
            val pad = if (stream(m) || zero(a) || optStr(o, "padding", "pkcs5").lowercase() == "none") "NoPadding" else "PKCS5Padding"
            val c = if (bc) Cipher.getInstance("$jce/$m/$pad", "BC") else Cipher.getInstance("$jce/$m/$pad")
            val ks = SecretKeySpec(key, jce)
            when {
                m == "ECB" -> c.init(dir, ks)
                m == "GCM" -> {
                    if (block != 16) throw ScriptError(null, null, "$name: GCM 은 128비트 블록(AES/SEED/ARIA)만 됩니다")
                    val iv = bytesArg(a, 2, Charsets.UTF_8)
                    if (iv.isEmpty()) throw ScriptError(null, null, "$name: GCM 은 IV(nonce)가 필요합니다 — 12바이트 권장")
                    c.init(dir, ks, GCMParameterSpec(num(opt(a, 3), "tagBits", 128), iv))
                    optBytes(o, "aad", cs(o))?.let { c.updateAAD(it) }
                }
                else -> {
                    val iv = bytesArg(a, 2, Charsets.UTF_8)
                    if (iv.size != block) throw ScriptError(null, null, "$name: IV 는 ${block}바이트여야 합니다(현재 ${iv.size})")
                    c.init(dir, ks, IvParameterSpec(iv))
                }
            }
            return c
        }
        fun enc(a: Array<Value>, plain: ByteArray): ByteArray {
            val data = if (zero(a) && plain.size % block != 0) plain.copyOf(plain.size + block - plain.size % block) else plain
            return cipher(a, Cipher.ENCRYPT_MODE).doFinal(data)
        }
        fun dec(a: Array<Value>, raw: ByteArray): ByteArray {
            val out = cipher(a, Cipher.DECRYPT_MODE).doFinal(raw)
            return if (zero(a)) out.copyOf(out.indexOfLast { it != 0.toByte() } + 1) else out
        }
        return obj(
            "encrypt" to fn { a -> encoded(enc(a, str(a, 0).toByteArray(cs(opt(a, 3)))), opt(a, 3), "b64") },
            "decrypt" to fn { a -> String(dec(a, decodeEncoded(str(a, 0), opt(a, 3), "b64")), cs(opt(a, 3))) },
            "encryptBytes" to fn { a -> u8(enc(a, bytesArg(a, 0, Charsets.UTF_8))) },
            "decryptBytes" to fn { a -> u8(dec(a, bytesArg(a, 0, Charsets.UTF_8))) },
        )
    }

    // ---- RSA · EC · JWT ----
    /** padding: `pkcs1`(기본) · `oaep`(SHA-256) · `oaep-sha1` · `none`. 공개키로 암호화, 개인키로 복호화. */
    private fun rsaCipher(a: Array<Value>, dir: Int): Cipher {
        val o = opt(a, 2)
        val t = when (optStr(o, "padding", "pkcs1").lowercase()) {
            "oaep", "oaep-sha256" -> "RSA/ECB/OAEPWithSHA-256AndMGF1Padding"
            "oaep-sha1" -> "RSA/ECB/OAEPWithSHA-1AndMGF1Padding"
            "none" -> "RSA/ECB/NoPadding"
            else -> "RSA/ECB/PKCS1Padding"
        }
        val kf = KeyFactory.getInstance("RSA")
        val key = if (dir == Cipher.ENCRYPT_MODE) kf.generatePublic(X509EncodedKeySpec(pem(str(a, 0), "PUBLIC KEY")))
        else kf.generatePrivate(PKCS8EncodedKeySpec(pem(str(a, 0), "PRIVATE KEY")))
        return Cipher.getInstance(t).apply { init(dir, key) }
    }
    private fun rsaSign(pemKey: String, data: ByteArray, alg: String): ByteArray {
        val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(pem(pemKey, "PRIVATE KEY")))
        return Signature.getInstance(alg).apply { initSign(key); update(data) }.sign()
    }
    /** JWS 서명 — HS(HMAC) · RS(RSA) · ES(ECDSA, JWS 규약대로 DER 이 아닌 R||S). */
    private fun jwtSign(alg: String, input: ByteArray, a: Array<Value>): ByteArray {
        val bits = alg.drop(2)
        return when {
            alg.startsWith("HS") -> Mac.getInstance("HmacSHA$bits").apply { init(SecretKeySpec(bytesArg(a, 1, Charsets.UTF_8), "HmacSHA$bits")) }.doFinal(input)
            alg.startsWith("RS") -> rsaSign(str(a, 1), input, "SHA${bits}withRSA")
            alg.startsWith("ES") -> {
                val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pem(str(a, 1), "PRIVATE KEY")))
                Signature.getInstance("SHA${bits}withECDSAinP1363Format").apply { initSign(key); update(input) }.sign()
            }
            else -> throw ScriptError(null, null, "fl.jwt: alg 는 HS256/384/512 · RS256/384/512 · ES256/384/512")
        }
    }
    private fun jwtVerify(token: String, a: Array<Value>): Boolean {
        val p = token.split('.')
        if (p.size != 3) return false
        val input = "${p[0]}.${p[1]}".toByteArray(Charsets.US_ASCII)
        val sig = try { b64urlDec(p[2]) } catch (e: Exception) { return false }
        val header = try { a[0].context.eval("js", "JSON.parse").execute(String(b64urlDec(p[0]), Charsets.UTF_8)) } catch (e: Exception) { return false }
        val alg = optStr(opt(a, 2), "alg", "").ifBlank { header.getMember("alg")?.takeIf { !it.isNull }?.let { show(it) } ?: "" }.uppercase()
        val bits = alg.drop(2)
        val okSig = when {
            alg.startsWith("HS") -> MessageDigest.isEqual(sig, jwtSign(alg, input, a))
            alg.startsWith("RS") -> {
                val key = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(pem(str(a, 1), "PUBLIC KEY")))
                Signature.getInstance("SHA${bits}withRSA").apply { initVerify(key); update(input) }.verify(sig)
            }
            alg.startsWith("ES") -> {
                val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(pem(str(a, 1), "PUBLIC KEY")))
                Signature.getInstance("SHA${bits}withECDSAinP1363Format").apply { initVerify(key); update(input) }.verify(sig)
            }
            else -> throw ScriptError(null, null, "fl.jwt: alg 를 알 수 없습니다 — '$alg'")
        }
        if (!okSig) return false
        if (flag(opt(a, 2), "skipExpiry")) return true
        // exp/nbf 는 있으면 본다(초 단위 epoch) — 만료 토큰을 통과시키지 않는 게 기본.
        val payload = try { a[0].context.eval("js", "JSON.parse").execute(String(b64urlDec(p[1]), Charsets.UTF_8)) } catch (e: Exception) { return false }
        val now = System.currentTimeMillis() / 1000
        val exp = payload.getMember("exp")?.takeIf { it.isNumber }?.asLong()
        val nbf = payload.getMember("nbf")?.takeIf { it.isNumber }?.asLong()
        return (exp == null || now <= exp) && (nbf == null || now >= nbf)
    }

    // ---- 체크섬 ----
    /** CRC-16 — `ccitt`(CCITT-FALSE: init FFFF, poly 1021) · `modbus`(init FFFF, 반사 poly A001). */
    private fun crc16(data: ByteArray, variant: String): Int {
        var c = 0xFFFF
        if (variant == "modbus") {
            for (b in data) { c = c xor (b.toInt() and 0xff); repeat(8) { c = if (c and 1 != 0) (c ushr 1) xor 0xA001 else c ushr 1 } }
        } else {
            for (b in data) { c = c xor ((b.toInt() and 0xff) shl 8); repeat(8) { c = if (c and 0x8000 != 0) ((c shl 1) xor 0x1021) and 0xFFFF else (c shl 1) and 0xFFFF } }
        }
        return c and 0xFFFF
    }
    /** 체크섬 출력 — `hex`(기본, 자릿수 고정) · `dec`(10진 문자열). */
    private fun checksum(v: Long, digits: Int, o: Value?): String =
        if (optStr(o, "out", "hex") == "dec") v.toString() else String.format("%0${digits}x", v)

    // ---- 인자/변환 ----
    internal fun show(v: Value): String = if (v.isString) v.asString() else v.toString()
    internal fun str(a: Array<Value>, i: Int): String = a.getOrNull(i)?.takeIf { !it.isNull }?.let { show(it) } ?: ""
    private fun num(a: Array<Value>, i: Int, def: Int): Int = a.getOrNull(i)?.takeIf { it.isNumber }?.asInt() ?: str(a, i).toIntOrNull() ?: def
    private fun num(o: Value?, k: String, def: Int): Int = o?.getMember(k)?.takeIf { it.isNumber }?.asInt() ?: def
    private fun opt(a: Array<Value>, i: Int): Value? = a.getOrNull(i)?.takeIf { !it.isNull && it.hasMembers() }
    private fun optStr(o: Value?, k: String, def: String): String = o?.getMember(k)?.takeIf { !it.isNull }?.let { show(it) } ?: def
    private fun flag(o: Value?, k: String): Boolean = o?.getMember(k)?.takeIf { !it.isNull }?.let { if (it.isBoolean) it.asBoolean() else show(it) == "true" } ?: false
    private fun cs(o: Value?): Charset = charset(optStr(o, "charset", "UTF-8"))
    private fun charset(name: String): Charset = try { if (name.isBlank()) Charsets.UTF_8 else Charset.forName(name.trim()) } catch (e: Exception) { throw ScriptError(null, null, "fl: 알 수 없는 charset '$name'") }
    private fun bytesOf(v: Value, cs: Charset): ByteArray =
        if (v.hasArrayElements()) ByteArray(v.arraySize.toInt()) { k -> (v.getArrayElement(k.toLong()).asLong() and 0xff).toByte() } else show(v).toByteArray(cs)
    /** 배열(Uint8Array 또는 fl 이 돌려준 배열)이면 바이트로, 아니면 문자열을 charset 으로. */
    private fun bytesArg(a: Array<Value>, i: Int, cs: Charset): ByteArray {
        val v = a.getOrNull(i)?.takeIf { !it.isNull } ?: return ByteArray(0)
        return bytesOf(v, cs)
    }
    private fun optBytes(o: Value?, k: String, cs: Charset): ByteArray? = o?.getMember(k)?.takeIf { !it.isNull }?.let { bytesOf(it, cs) }
    /** JS 값 → JSON 문자열(문자열이면 그대로 — 이미 JSON 이라고 본다). */
    private fun jsonOf(v: Value): String =
        if (v.isString) v.asString() else v.context.eval("js", "JSON.stringify").execute(v).let { if (it.isNull) "" else it.asString() }
    private fun u8(b: ByteArray): Any = ProxyArray.fromList(b.map { (it.toInt() and 0xff) as Any })
    private fun b64(b: ByteArray) = Base64.getEncoder().encodeToString(b)
    private fun b64url(b: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    private fun b64urlDec(s: String): ByteArray = Base64.getUrlDecoder().decode(s.trim())
    private fun hex(b: ByteArray) = HexFormat.of().formatHex(b)
    private fun encoded(b: ByteArray, o: Value?, def: String): String = when (optStr(o, "out", def)) {
        "hex" -> hex(b); "b64" -> b64(b); "b64url" -> b64url(b)
        else -> throw ScriptError(null, null, "fl: out 은 'b64' | 'b64url' | 'hex'")
    }
    private fun decodeEncoded(s: String, o: Value?, def: String): ByteArray = when (optStr(o, "out", def)) {
        "hex" -> HexFormat.of().parseHex(s.trim())
        "b64url" -> b64urlDec(s)
        else -> Base64.getDecoder().decode(s.trim())
    }
    /** dec 계열 출력 — `{ as: 'bytes' }` 면 바이트 배열, 기본은 텍스트(charset 옵션). */
    private fun out(b: ByteArray, o: Value?): Any = if (optStr(o, "as", "text") == "bytes") u8(b) else String(b, cs(o))
    private fun pem(s: String, label: String): ByteArray {
        val body = s.replace(Regex("-----[A-Z ]*$label-----"), "").replace(Regex("\\s"), "")
        if (body.isEmpty()) throw ScriptError(null, null, "fl: PEM($label)이 비었습니다 — PKCS#8(BEGIN $label) 형식이어야 합니다")
        return Base64.getDecoder().decode(body)
    }
}

/** 편집기 자동완성·MCP 가이드용 매니페스트 — fl 에 함수를 추가하면 여기도 한 줄. */
object FlApi {
    private fun e(path: String, sig: String, doc: String, ex: String) = FlApiEntry(path, sig, doc, ex)
    private fun cipher(ns: String, name: String, keyDoc: String, iv: Int = 16, gcm: Boolean = true): List<FlApiEntry> {
        val modes = "'CBC'|'ECB'|'CTR'|'CFB'|'OFB'" + if (gcm) "|'GCM'" else ""
        val opt = "{ mode?: $modes, padding?: 'pkcs5'|'zero'|'none', out?: 'b64'|'b64url'|'hex', charset?" + (if (gcm) ", aad?, tagBits?" else "") + " }"
        return listOf(
            e("fl.$ns.encrypt", "fl.$ns.encrypt(text, key, iv, $opt)", "$name 암호화 — 기본 CBC/PKCS5·base64, $keyDoc, IV ${iv}B" + if (gcm) ". GCM 은 IV 12B 권장 + 태그가 암호문 뒤에 붙는다(aad 까지 같아야 복호화)" else "", "fl.$ns.encrypt(inputs.input, config.key, config.iv)"),
            e("fl.$ns.decrypt", "fl.$ns.decrypt(cipher, key, iv, $opt)", "$name 복호화 — 암호화와 같은 옵션으로", "fl.$ns.decrypt(inputs.input, config.key, config.iv)"),
            e("fl.$ns.encryptBytes", "fl.$ns.encryptBytes(bytes, key, iv, $opt)", "$name 암호화(바이트 → 바이트, 전문 코덱용)", "fl.$ns.encryptBytes(body, ctx.config.key, ctx.config.iv)"),
            e("fl.$ns.decryptBytes", "fl.$ns.decryptBytes(bytes, key, iv, $opt)", "$name 복호화(바이트)", "fl.$ns.decryptBytes(body, ctx.config.key, ctx.config.iv)"),
        )
    }
    private fun hash(ns: String, name: String) = e("fl.hash.$ns", "fl.hash.$ns(text|bytes, { out?: 'hex'|'b64'|'b64url', charset? })", "$name 해시(기본 hex)", "fl.hash.$ns(inputs.input)")
    private fun hmac(ns: String, name: String) = e("fl.hmac.$ns", "fl.hmac.$ns(key, data, { out?: 'hex'|'b64'|'b64url', charset? })", "$name 서명(기본 hex — 키는 문자열/바이트)", "fl.hmac.$ns(config.secret, inputs.input)")
    val MANIFEST: List<FlApiEntry> = listOf(
        e("fl.b64.enc", "fl.b64.enc(text|bytes, { url?: true, charset? })", "base64 인코딩(url:true = URL-safe, 패딩 없음)", "fl.b64.enc('hi')"),
        e("fl.b64.dec", "fl.b64.dec(b64, { url?: true, as?: 'text'|'bytes', charset? })", "base64 디코딩", "fl.b64.dec('aGk=')"),
        e("fl.hex.enc", "fl.hex.enc(text|bytes, { charset? })", "16진수 인코딩(소문자)", "fl.hex.enc('AB')"),
        e("fl.hex.dec", "fl.hex.dec(hex, { as?: 'text'|'bytes', charset? })", "16진수 디코딩 — 바이트 키를 만들 때 `{ as: 'bytes' }`", "fl.hex.dec('4142')"),
    ) + listOf(hash("md5", "MD5"), hash("sha1", "SHA-1"), hash("sha224", "SHA-224"), hash("sha256", "SHA-256"),
        hash("sha384", "SHA-384"), hash("sha512", "SHA-512"), hash("sha3_256", "SHA3-256"), hash("sha3_512", "SHA3-512"),
    ) + listOf(hmac("md5", "HMAC-MD5"), hmac("sha1", "HMAC-SHA1"), hmac("sha256", "HMAC-SHA256"), hmac("sha384", "HMAC-SHA384"), hmac("sha512", "HMAC-SHA512"),
        e("fl.pbkdf2", "fl.pbkdf2(password, salt, iterations, bits, { alg?: 'SHA256'|'SHA1'|'SHA512', out? })", "PBKDF2 키 유도(기본 SHA256·10000회·256비트·hex)", "fl.pbkdf2(config.pw, config.salt, 10000, 256)"),
    ) + cipher("aes", "AES", "키 16/24/32B") + cipher("seed", "SEED", "국내 표준, 키 16B") + cipher("aria", "ARIA", "국내 표준, 키 16/24/32B") +
        cipher("des", "DES", "레거시 전용, 키 8B", iv = 8, gcm = false) + cipher("des3", "3DES(DESede)", "레거시, 키 16B(K1K2K1 자동 확장)/24B", iv = 8, gcm = false) + listOf(
        e("fl.rsa.sign", "fl.rsa.sign(pemPrivateKey, data, { alg?: 'SHA256withRSA', out?: 'b64'|'b64url'|'hex' })", "RSA 서명(PKCS#8 PEM, 기본 base64)", "fl.rsa.sign(config.privateKey, inputs.input)"),
        e("fl.rsa.verify", "fl.rsa.verify(pemPublicKey, data, signature, { alg?, out? })", "RSA 서명 검증 → true/false", "fl.rsa.verify(config.publicKey, inputs.input, inputs.sig)"),
        e("fl.rsa.encrypt", "fl.rsa.encrypt(pemPublicKey, text, { padding?: 'pkcs1'|'oaep'|'oaep-sha1'|'none', out?, charset? })", "RSA 공개키 암호화(기본 PKCS#1 v1.5 · base64)", "fl.rsa.encrypt(config.publicKey, inputs.input, { padding: 'oaep' })"),
        e("fl.rsa.decrypt", "fl.rsa.decrypt(pemPrivateKey, cipher, { padding?, out?, charset? })", "RSA 개인키 복호화", "fl.rsa.decrypt(config.privateKey, inputs.input)"),
        e("fl.rsa.encryptBytes", "fl.rsa.encryptBytes(pemPublicKey, bytes, { padding? })", "RSA 암호화(바이트 → 바이트)", "fl.rsa.encryptBytes(config.publicKey, body)"),
        e("fl.rsa.decryptBytes", "fl.rsa.decryptBytes(pemPrivateKey, bytes, { padding? })", "RSA 복호화(바이트)", "fl.rsa.decryptBytes(config.privateKey, body)"),
        e("fl.ec.sign", "fl.ec.sign(pemPrivateKey, data, { alg?: 'SHA256withECDSA', out? })", "ECDSA 서명(PKCS#8 PEM)", "fl.ec.sign(config.privateKey, inputs.input)"),
        e("fl.ec.verify", "fl.ec.verify(pemPublicKey, data, signature, { alg?, out? })", "ECDSA 서명 검증 → true/false", "fl.ec.verify(config.publicKey, inputs.input, inputs.sig)"),
        e("fl.jwt.sign", "fl.jwt.sign(payload, key, { alg?: 'HS256'|'HS384'|'HS512'|'RS256'|'ES256', header? })", "JWT 발급 — HS 는 공유키, RS/ES 는 PKCS#8 PEM 개인키", "fl.jwt.sign({ sub: inputs.id, exp: 1893456000 }, config.secret)"),
        e("fl.jwt.verify", "fl.jwt.verify(token, key, { alg?, skipExpiry?: true })", "JWT 검증 → true/false (exp·nbf 도 확인, alg 는 헤더에서)", "fl.jwt.verify(inputs.token, config.secret)"),
        e("fl.jwt.decode", "fl.jwt.decode(token)", "JWT 를 { header, payload } 로 — 서명 검증 없음", "fl.jwt.decode(inputs.token).payload.sub"),
        e("fl.crc32", "fl.crc32(text|bytes, { out?: 'hex'|'dec', charset? })", "CRC-32(기본 8자리 hex)", "fl.crc32(body)"),
        e("fl.crc16", "fl.crc16(text|bytes, { variant?: 'ccitt'|'modbus', out?: 'hex'|'dec', charset? })", "CRC-16(기본 CCITT-FALSE, 4자리 hex)", "fl.crc16(body, { variant: 'modbus' })"),
        e("fl.bcc", "fl.bcc(text|bytes, { out?: 'hex'|'dec', charset? })", "BCC(전 바이트 XOR, 2자리 hex) — 전문 검증코드", "fl.bcc(body)"),
        e("fl.lrc", "fl.lrc(text|bytes, { out?: 'hex'|'dec', charset? })", "LRC(합의 2의 보수, 2자리 hex)", "fl.lrc(body)"),
        e("fl.random.bytes", "fl.random.bytes(n)", "안전 난수 바이트(IV·nonce 용)", "fl.random.bytes(12)"),
        e("fl.random.hex", "fl.random.hex(n)", "안전 난수 hex 문자열(n 바이트)", "fl.random.hex(16)"),
        e("fl.random.b64", "fl.random.b64(n)", "안전 난수 base64(n 바이트)", "fl.random.b64(16)"),
        e("fl.uuid", "fl.uuid()", "랜덤 UUID v4", "fl.uuid()"),
        e("fl.gzip.compress", "fl.gzip.compress(text|bytes, { out?: 'b64'|'hex', charset? })", "gzip 압축(out 주면 문자열, 없으면 바이트)", "fl.gzip.compress(inputs.input, { out: 'b64' })"),
        e("fl.gzip.decompress", "fl.gzip.decompress(bytes, { as?: 'text'|'bytes', charset? })", "gzip 해제", "fl.gzip.decompress(fl.b64.dec(inputs.input, { as: 'bytes' }))"),
        e("fl.bytes", "fl.bytes(text, charset?)", "문자열 → 바이트 배열(EUC-KR/MS949 등)", "fl.bytes('홍길동', 'EUC-KR')"),
        e("fl.text", "fl.text(bytes, charset?)", "바이트 배열 → 문자열", "fl.text(body, 'EUC-KR')"),
        e("fl.pad.left", "fl.pad.left(text, len, ch?, { charset? })", "왼쪽 패딩(바이트 길이 기준 — 숫자 0 채움)", "fl.pad.left(inputs.input, 12, '0')"),
        e("fl.pad.right", "fl.pad.right(text, len, ch?, { charset? })", "오른쪽 패딩(바이트 길이 기준 — 한글 필드 공백 채움)", "fl.pad.right(inputs.input, 20, ' ', { charset: 'EUC-KR' })"),
        e("fl.mask", "fl.mask(text, keepFront, keepBack, ch?)", "가운데 마스킹", "fl.mask(inputs.input, 6, 4)"),
        e("fl.now", "fl.now(pattern?, zone?)", "현재 일시(기본 ISO UTC, 패턴은 Java DateTimeFormatter, 기본 KST)", "fl.now('yyyyMMddHHmmss')"),
        e("fl.json.parse", "fl.json.parse(text)", "JSON 파싱", "fl.json.parse(inputs.input).user.name"),
        e("fl.json.stringify", "fl.json.stringify(value)", "JSON 직렬화", "fl.json.stringify({ a: 1 })"),
        e("fl.log", "fl.log(...values)", "실행 패널 콘솔에 출력(서빙 땐 무시)", "fl.log('key', config.key)"),
    )
}
