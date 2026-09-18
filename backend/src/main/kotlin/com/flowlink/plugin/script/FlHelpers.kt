package com.flowlink.plugin.script

import com.flowlink.common.text.NowTokens
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.graalvm.polyglot.Value
import org.graalvm.polyglot.proxy.ProxyArray
import org.graalvm.polyglot.proxy.ProxyExecutable
import org.graalvm.polyglot.proxy.ProxyObject
import java.nio.charset.Charset
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Security
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.HexFormat
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/** `fl.*` 한 함수의 문서 — 편집기 자동완성·MCP 가이드가 같은 목록을 쓴다. */
data class FlApiEntry(val path: String, val signature: String, val doc: String, val example: String)

/**
 * 스크립트에 주입되는 `fl` 객체 — 전부 Graal 프록시(ProxyObject/ProxyExecutable)라 호스트 리플렉션 경로가 없다.
 * 기본값 = 회사 관례(UTF-8 · AES/SEED/ARIA/DES 는 CBC/PKCS5Padding · 출력 base64). 다른 조합은 옵션 객체 `{ out, charset, mode, padding, as }` 로만.
 * 바이트는 JS 쪽 배열(Uint8Array 또는 fl 이 돌려준 배열) ↔ 여기 ByteArray. 잘못된 인자는 ScriptError(스크립트 오류로 표면화).
 */
object FlHelpers {
    init { if (Security.getProvider("BC") == null) Security.addProvider(BouncyCastleProvider()) }

    fun build(logs: MutableList<String>): ProxyObject = obj(
        "b64" to obj("enc" to fn { a -> b64(bytesArg(a, 0, cs(opt(a, 1)))) }, "dec" to fn { a -> out(Base64.getDecoder().decode(str(a, 0).trim()), opt(a, 1)) }),
        "hex" to obj("enc" to fn { a -> hex(bytesArg(a, 0, cs(opt(a, 1)))) }, "dec" to fn { a -> out(HexFormat.of().parseHex(str(a, 0).trim()), opt(a, 1)) }),
        "hash" to obj("sha256" to digest("SHA-256"), "sha1" to digest("SHA-1"), "md5" to digest("MD5")),
        "hmac" to obj("sha256" to fn { a ->
            val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(str(a, 0).toByteArray(Charsets.UTF_8), "HmacSHA256")) }
            encoded(mac.doFinal(bytesArg(a, 1, cs(opt(a, 2)))), opt(a, 2), "hex")
        }),
        "aes" to cipherNs("AES"), "seed" to cipherNs("SEED"), "aria" to cipherNs("ARIA"), "des" to cipherNs("DES"),
        "rsa" to obj(
            "sign" to fn { a ->
                val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(pem(str(a, 0), "PRIVATE KEY")))
                val sig = Signature.getInstance(optStr(opt(a, 2), "alg", "SHA256withRSA")).apply { initSign(key); update(bytesArg(a, 1, Charsets.UTF_8)) }.sign()
                encoded(sig, opt(a, 2), "b64")
            },
            "verify" to fn { a ->
                val key = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(pem(str(a, 0), "PUBLIC KEY")))
                Signature.getInstance(optStr(opt(a, 3), "alg", "SHA256withRSA")).apply { initVerify(key); update(bytesArg(a, 1, Charsets.UTF_8)) }
                    .verify(decodeEncoded(str(a, 2), opt(a, 3), "b64"))
            },
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
            "stringify" to fn { a -> a[0].context.eval("js", "JSON.stringify").execute(a[0]).let { if (it.isNull) "" else it.asString() } },
        ),
        "log" to fn { a -> logs.add(a.joinToString(" ") { show(it) }); null },
    )

    // ---- 프록시 빌더 ----
    private fun obj(vararg m: Pair<String, Any>): ProxyObject = ProxyObject.fromMap(mapOf(*m))
    internal fun fn(body: (Array<Value>) -> Any?): ProxyExecutable = ProxyExecutable { args ->
        try { body(args) } catch (e: ScriptError) { throw e } catch (e: Exception) { throw ScriptError(null, null, "fl: ${e.message ?: e.toString()}", e) }
    }
    private fun digest(alg: String) = fn { a -> encoded(MessageDigest.getInstance(alg).digest(bytesArg(a, 0, cs(opt(a, 1)))), opt(a, 1), "hex") }
    private fun padFn(left: Boolean) = fn { a ->
        val s = str(a, 0); val len = num(a, 1, 0); val ch = str(a, 2).ifEmpty { " " }; val cs = cs(opt(a, 3))
        val fill = ch.toByteArray(cs); val raw = s.toByteArray(cs)
        if (raw.size >= len) s else { val padBytes = ByteArray(len - raw.size) { fill[it % fill.size] }; String(if (left) padBytes + raw else raw + padBytes, cs) }
    }
    /**
     * AES/SEED/ARIA/DES 공용 — encrypt/decrypt(text) · encryptBytes/decryptBytes(bytes). CBC(기본)는 iv 가 블록 크기(AES/SEED/ARIA 16B, DES 8B) 필수, ECB 는 iv 무시.
     * 키·IV 는 문자열(UTF-8 바이트) 또는 바이트 배열(`fl.hex.dec(k, { as: 'bytes' })` 로 hex/base64 키). `padding: 'zero'` 는 레거시 호환 —
     * NoPadding 에 0x00 으로 블록을 채우고 복호화 때 꼬리 0x00 을 지운다(기본 PKCS5).
     */
    private fun cipherNs(alg: String): ProxyObject {
        val keySizes = when (alg) { "SEED" -> listOf(16); "DES" -> listOf(8); else -> listOf(16, 24, 32) }
        val block = if (alg == "DES") 8 else 16
        fun zero(a: Array<Value>) = optStr(opt(a, 3), "padding", "pkcs5").lowercase() == "zero"
        fun cipher(a: Array<Value>, mode: Int): Cipher {
            val o = opt(a, 3); val m = optStr(o, "mode", "CBC").uppercase()
            val key = bytesArg(a, 1, Charsets.UTF_8)
            if (key.size !in keySizes) throw ScriptError(null, null, "fl.${alg.lowercase()}: 키는 ${keySizes.joinToString("/")}바이트여야 합니다(현재 ${key.size})")
            val t = "$alg/$m/" + if (zero(a)) "NoPadding" else "PKCS5Padding"
            val c = if (alg == "AES" || alg == "DES") Cipher.getInstance(t) else Cipher.getInstance(t, "BC")
            if (m == "ECB") c.init(mode, SecretKeySpec(key, alg)) else {
                val iv = bytesArg(a, 2, Charsets.UTF_8)
                if (iv.size != block) throw ScriptError(null, null, "fl.${alg.lowercase()}: IV 는 ${block}바이트여야 합니다(현재 ${iv.size})")
                c.init(mode, SecretKeySpec(key, alg), IvParameterSpec(iv))
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

    // ---- 인자/변환 ----
    internal fun show(v: Value): String = if (v.isString) v.asString() else v.toString()
    internal fun str(a: Array<Value>, i: Int): String = a.getOrNull(i)?.takeIf { !it.isNull }?.let { show(it) } ?: ""
    private fun num(a: Array<Value>, i: Int, def: Int): Int = a.getOrNull(i)?.takeIf { it.isNumber }?.asInt() ?: str(a, i).toIntOrNull() ?: def
    private fun opt(a: Array<Value>, i: Int): Value? = a.getOrNull(i)?.takeIf { !it.isNull && it.hasMembers() }
    private fun optStr(o: Value?, k: String, def: String): String = o?.getMember(k)?.takeIf { !it.isNull }?.let { show(it) } ?: def
    private fun cs(o: Value?): Charset = charset(optStr(o, "charset", "UTF-8"))
    private fun charset(name: String): Charset = try { if (name.isBlank()) Charsets.UTF_8 else Charset.forName(name.trim()) } catch (e: Exception) { throw ScriptError(null, null, "fl: 알 수 없는 charset '$name'") }
    /** 배열(Uint8Array 또는 fl 이 돌려준 배열)이면 바이트로, 아니면 문자열을 charset 으로. */
    private fun bytesArg(a: Array<Value>, i: Int, cs: Charset): ByteArray {
        val v = a.getOrNull(i) ?: return ByteArray(0)
        if (v.hasArrayElements()) return ByteArray(v.arraySize.toInt()) { k -> (v.getArrayElement(k.toLong()).asLong() and 0xff).toByte() }
        return str(a, i).toByteArray(cs)
    }
    private fun u8(b: ByteArray): Any = ProxyArray.fromList(b.map { (it.toInt() and 0xff) as Any })
    private fun b64(b: ByteArray) = Base64.getEncoder().encodeToString(b)
    private fun hex(b: ByteArray) = HexFormat.of().formatHex(b)
    private fun encoded(b: ByteArray, o: Value?, def: String): String = when (optStr(o, "out", def)) { "hex" -> hex(b); "b64" -> b64(b); else -> throw ScriptError(null, null, "fl: out 은 'b64' | 'hex'") }
    private fun decodeEncoded(s: String, o: Value?, def: String): ByteArray = if (optStr(o, "out", def) == "hex") HexFormat.of().parseHex(s.trim()) else Base64.getDecoder().decode(s.trim())
    /** dec 계열 출력 — `{ as: 'bytes' }` 면 바이트 배열, 기본은 텍스트(charset 옵션). */
    private fun out(b: ByteArray, o: Value?): Any = if (optStr(o, "as", "text") == "bytes") u8(b) else String(b, cs(o))
    private fun pem(s: String, label: String): ByteArray {
        val body = s.replace(Regex("-----[A-Z ]*$label-----"), "").replace(Regex("\\s"), "")
        if (body.isEmpty()) throw ScriptError(null, null, "fl.rsa: PEM($label)이 비었습니다")
        return Base64.getDecoder().decode(body)
    }
}

/** 편집기 자동완성·MCP 가이드용 매니페스트 — fl 에 함수를 추가하면 여기도 한 줄. */
object FlApi {
    private fun e(path: String, sig: String, doc: String, ex: String) = FlApiEntry(path, sig, doc, ex)
    private fun cipher(ns: String, name: String, keyDoc: String, iv: Int = 16): List<FlApiEntry> = listOf(
        e("fl.$ns.encrypt", "fl.$ns.encrypt(text, key, iv, { mode?: 'CBC'|'ECB', padding?: 'pkcs5'|'zero', out?: 'b64'|'hex', charset? })", "$name 암호화(CBC/PKCS5, $keyDoc, IV ${iv}B, 기본 base64 — 키·IV 는 문자열 또는 바이트 배열, padding 'zero' 는 레거시 0x00 채움)", "fl.$ns.encrypt(inputs.input, config.key, config.iv)"),
        e("fl.$ns.decrypt", "fl.$ns.decrypt(cipher, key, iv, { mode?, padding?, out?, charset? })", "$name 복호화", "fl.$ns.decrypt(inputs.input, config.key, config.iv)"),
        e("fl.$ns.encryptBytes", "fl.$ns.encryptBytes(bytes, key, iv, { mode?, padding? })", "$name 암호화(바이트 → 바이트, 전문 코덱용)", "fl.$ns.encryptBytes(body, ctx.config.key, ctx.config.iv)"),
        e("fl.$ns.decryptBytes", "fl.$ns.decryptBytes(bytes, key, iv, { mode?, padding? })", "$name 복호화(바이트)", "fl.$ns.decryptBytes(body, ctx.config.key, ctx.config.iv)"),
    )
    val MANIFEST: List<FlApiEntry> = listOf(
        e("fl.b64.enc", "fl.b64.enc(text|bytes, { charset? })", "base64 인코딩", "fl.b64.enc('hi')"),
        e("fl.b64.dec", "fl.b64.dec(b64, { as?: 'text'|'bytes', charset? })", "base64 디코딩", "fl.b64.dec('aGk=')"),
        e("fl.hex.enc", "fl.hex.enc(text|bytes, { charset? })", "16진수 인코딩(소문자)", "fl.hex.enc('AB')"),
        e("fl.hex.dec", "fl.hex.dec(hex, { as?: 'text'|'bytes', charset? })", "16진수 디코딩", "fl.hex.dec('4142')"),
        e("fl.hash.sha256", "fl.hash.sha256(text|bytes, { out?: 'hex'|'b64', charset? })", "SHA-256 해시(기본 hex)", "fl.hash.sha256(inputs.input)"),
        e("fl.hash.sha1", "fl.hash.sha1(text|bytes, { out?, charset? })", "SHA-1 해시", "fl.hash.sha1('x')"),
        e("fl.hash.md5", "fl.hash.md5(text|bytes, { out?, charset? })", "MD5 해시", "fl.hash.md5('x')"),
        e("fl.hmac.sha256", "fl.hmac.sha256(key, data, { out?: 'hex'|'b64', charset? })", "HMAC-SHA256 서명(기본 hex)", "fl.hmac.sha256(config.secret, inputs.input)"),
    ) + cipher("aes", "AES", "키 16/24/32B") + cipher("seed", "SEED", "국내 표준, 키 16B") + cipher("aria", "ARIA", "국내 표준, 키 16/24/32B") + cipher("des", "DES", "레거시 전용, 키 8B", iv = 8) + listOf(
        e("fl.rsa.sign", "fl.rsa.sign(pemPrivateKey, data, { alg?: 'SHA256withRSA', out?: 'b64'|'hex' })", "RSA 서명(PKCS#8 PEM, 기본 base64)", "fl.rsa.sign(config.privateKey, inputs.input)"),
        e("fl.rsa.verify", "fl.rsa.verify(pemPublicKey, data, signature, { alg?, out? })", "RSA 서명 검증 → true/false", "fl.rsa.verify(config.publicKey, inputs.input, inputs.sig)"),
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
