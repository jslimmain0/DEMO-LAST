package com.flowlink.common.tcp

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.Arrays

/**
 * 고정길이 전문 바이트 유틸 — TCP 노드(요청 조립)와 TCP mock(응답 조립) 공용.
 * 길이는 전부 **바이트** 기준(EUC-KR 한글 2바이트 등 멀티바이트 정확). 초과는 절단, 부족은 패딩.
 */
object TcpBytes {

    /** 값을 [length] 바이트 고정길이로 — 초과 절단, 부족 시 [pad](left|right, 기본 right) 방향으로 [padChar](기본 공백) 채움. */
    @JvmStatic
    fun fixedField(value: String?, length: Int, pad: String?, padChar: String?, cs: Charset): ByteArray {
        val raw = (value ?: "").toByteArray(cs)
        if (length <= 0) {
            return ByteArray(0)
        }
        if (raw.size == length) {
            return raw
        }
        if (raw.size > length) {
            return Arrays.copyOf(raw, length) // 초과 시 절단
        }
        val out = ByteArray(length)
        val pb = padByte(padChar, cs)
        if ("left".equals(pad, ignoreCase = true)) {
            val padCount = length - raw.size
            Arrays.fill(out, 0, padCount, pb)
            System.arraycopy(raw, 0, out, padCount, raw.size)
        } else { // 기본 right
            System.arraycopy(raw, 0, out, 0, raw.size)
            Arrays.fill(out, raw.size, length, pb)
        }
        return out
    }

    @JvmStatic
    fun padByte(padChar: String?, cs: Charset): Byte {
        val p = if (padChar == null || padChar.isEmpty()) " " else padChar
        val b = p.toByteArray(cs)
        return if (b.isNotEmpty()) b[0] else ' '.code.toByte()
    }

    /** 길이 프리픽스(ASCII 십진, [width] 자리 0 채움). 오버플로면 하위 자리만(방어적). */
    @JvmStatic
    fun prefix(declared: Int, width: Int): ByteArray {
        val s = String.format("%0" + width + "d", declared)
        val b = s.toByteArray(StandardCharsets.US_ASCII)
        if (b.size > width) {
            return Arrays.copyOfRange(b, b.size - width, b.size)
        }
        return b
    }

    /** 프리픽스 + 본문. [prefixLen] 0 이면 본문 그대로. */
    @JvmStatic
    fun withPrefix(body: ByteArray, prefixLen: Int, includesSelf: Boolean): ByteArray {
        if (prefixLen <= 0) return body
        val declared = if (includesSelf) body.size + prefixLen else body.size
        val p = prefix(declared, prefixLen)
        val m = ByteArray(p.size + body.size)
        System.arraycopy(p, 0, m, 0, p.size)
        System.arraycopy(body, 0, m, p.size, body.size)
        return m
    }

    @JvmStatic
    fun charset(name: String?, def: Charset): Charset {
        if (name == null || name.isBlank()) {
            return def
        }
        return try {
            Charset.forName(name.trim())
        } catch (e: Exception) {
            def
        }
    }

    /** 제어문자를 '.' 로 바꾼 표시용 문자열. */
    @JvmStatic
    fun printable(bytes: ByteArray, cs: Charset): String {
        val s = String(bytes, cs)
        val sb = StringBuilder(s.length)
        for (i in 0 until s.length) {
            val c = s[i]
            sb.append(if (c.code < 0x20) '.' else c)
        }
        return sb.toString()
    }

    private val HEX = "0123456789ABCDEF".toCharArray()

    /** 공백 구분 2자리 대문자 hex(바이트별) — 룩업 테이블(바이트당 String.format 회피). */
    @JvmStatic
    fun hexDump(bytes: ByteArray): String {
        if (bytes.isEmpty()) return ""
        val sb = StringBuilder(bytes.size * 3)
        for (i in bytes.indices) {
            if (i > 0) sb.append(' ')
            val v = bytes[i].toInt() and 0xFF
            sb.append(HEX[v ushr 4]).append(HEX[v and 0x0F])
        }
        return sb.toString()
    }

    /** 바이트 슬라이스(범위 클램프 — 예외 없음). */
    @JvmStatic
    fun slice(bytes: ByteArray, offset: Int, length: Int): ByteArray {
        val from = minOf(maxOf(offset, 0), bytes.size)
        val to = minOf(from + maxOf(length, 0), bytes.size)
        return bytes.copyOfRange(from, to)
    }

    /** 문자셋 디코딩 — 깨진/매핑 불가 바이트는 `\xB1` 형태로 원본 노출(물음표로 뭉개지 않음). */
    @JvmStatic
    fun decodeEscaped(bytes: ByteArray, cs: Charset): String {
        val dec = cs.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        try { return dec.decode(ByteBuffer.wrap(bytes)).toString() } catch (e: CharacterCodingException) { /* 느린 경로 */ }
        val maxB = Math.ceil(cs.newEncoder().maxBytesPerChar().toDouble()).toInt().coerceAtLeast(1)
        val sb = StringBuilder(bytes.size)
        var i = 0
        while (i < bytes.size) {
            var ok = false
            for (k in 1..maxB) {
                if (i + k > bytes.size) break
                try { sb.append(dec.reset().decode(ByteBuffer.wrap(bytes, i, k))); i += k; ok = true; break } catch (e: CharacterCodingException) { }
            }
            if (!ok) { sb.append(String.format("\\x%02X", bytes[i].toInt() and 0xFF)); i++ }
        }
        return sb.toString()
    }

    /** "0A FF" / "0aff" → 바이트. 형식 오류면 null. */
    @JvmStatic
    fun hexToBytes(hex: String): ByteArray? {
        val clean = hex.replace(Regex("[\\s:]"), "")
        if (clean.isEmpty()) return ByteArray(0)
        if (clean.length % 2 != 0 || !clean.all { it in "0123456789abcdefABCDEF" }) return null
        return ByteArray(clean.length / 2) { clean.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}
