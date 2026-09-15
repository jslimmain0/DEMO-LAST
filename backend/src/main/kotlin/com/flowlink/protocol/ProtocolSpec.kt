package com.flowlink.protocol

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.flowlink.common.tcp.TcpBytes
import java.nio.charset.Charset
import java.util.Locale

/** 전문 송수신 방향 — 분기 필드가 없을 때의 전문 키(request/response)이자 `"{disc}:{dir}"` 복합키의 접미. */
enum class Direction(val key: String) { SEND("request"), RECV("response") }

/**
 * 프로토콜(고정길이 전문 규격) — 프레이밍 옵션 + 헤더 표 + 거래코드별 본문 표. TCP 노드·TCP Mock·프록시가 공유한다.
 * offset 은 저장하지 않는다(앞 필드 len 누적 파생값). 길이는 전부 바이트.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class ProtocolSpec(
    val encoding: String? = null,          // 기본 EUC-KR
    val lengthField: String? = null,       // 헤더의 length 타입 필드 이름
    val lengthFormat: String? = null,      // ascii-decimal(기본) | binary
    val endian: String? = null,            // big(기본) | little — binary 일 때만
    val includesSelf: Boolean? = null,     // 길이값에 길이 필드 자신 포함(true=전체, false=전체-길이필드len)
    val discriminator: String? = null,     // 본문 표를 고르는 헤더 필드. 비면 request/response
    val header: List<Field>? = null,
    val messages: List<Message>? = null,   // 순서 있음(UI 탭)
    val messagePlugins: List<PluginRef>? = null,
) {
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class Field(
        val name: String? = null,
        val len: Int? = null,
        val type: String? = null,          // length | string | ascii | numeric | binary
        val pad: String? = null,           // left/zero | right/space | left/space | none
        val plugin: PluginRef? = null,
    ) {
        fun nameOrEmpty(): String = name?.trim().orEmpty()
        fun lenOrZero(): Int = len ?: 0
        fun typeOr(): String = (type ?: "string").trim().lowercase(Locale.ROOT).ifEmpty { "string" }
        fun padOr(): String = pad?.trim()?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() }
            ?: when (typeOr()) { "numeric", "length" -> "left/zero"; "binary" -> "none"; else -> "right/space" }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class Message(val key: String? = null, val label: String? = null, val fields: List<Field>? = null) {
        fun keyOrEmpty(): String = key?.trim().orEmpty()
        fun fieldsOrEmpty(): List<Field> = fields ?: emptyList()
        fun bodyLen(): Int = fieldsOrEmpty().sumOf { it.lenOrZero() }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class PluginRef(val id: String? = null, val config: Map<String, String>? = null) {
        fun configOrEmpty(): Map<String, String> = config ?: emptyMap()
    }

    fun charset(): Charset = TcpBytes.charset(encoding, Charset.forName("EUC-KR"))
    fun headerOrEmpty(): List<Field> = header ?: emptyList()
    fun messagesOrEmpty(): List<Message> = messages ?: emptyList()
    fun headerLen(): Int = headerOrEmpty().sumOf { it.lenOrZero() }
    fun isBinaryLength(): Boolean = (lengthFormat ?: "").trim().lowercase(Locale.ROOT) == "binary"
    fun isLittleEndian(): Boolean = (endian ?: "").trim().lowercase(Locale.ROOT) == "little"
    fun hasDiscriminator(): Boolean = !discriminator.isNullOrBlank()
    fun lengthFieldDef(): Field? = headerOrEmpty().firstOrNull { it.nameOrEmpty() == lengthField?.trim() }
    /** 길이 필드의 헤더 내 오프셋(없으면 -1). */
    fun lengthFieldOffset(): Int {
        var off = 0
        for (f in headerOrEmpty()) { if (f.nameOrEmpty() == lengthField?.trim()) return off; off += f.lenOrZero() }
        return -1
    }
    fun message(key: String): Message? = messagesOrEmpty().firstOrNull { it.keyOrEmpty() == key.trim() }
    /** 수신/송신 전문 표 조회 — `"{disc}:{dir}"` → `"{disc}"`; 분기 필드 없으면 dir 키. */
    fun lookup(disc: String?, direction: Direction): Message? {
        if (!hasDiscriminator()) return message(direction.key)
        val d = disc?.trim().orEmpty()
        return message("$d:${direction.key}") ?: message(d)
    }
    /** 전문 키의 discriminator 값 — `"0210:response"` → `"0210"`. */
    fun discValueOf(key: String): String = key.trim().substringBefore(':')
    fun totalLen(key: String): Int = headerLen() + (message(key)?.bodyLen() ?: 0)

    fun validate(): List<String> {
        val errs = ArrayList<String>()
        val lf = lengthField?.trim().orEmpty()
        if (lf.isEmpty()) errs += "길이 필드(lengthField)를 지정하세요."
        else {
            val def = lengthFieldDef()
            if (def == null) errs += "헤더에 길이 필드 '$lf' 가 없습니다."
            else {
                if (def.typeOr() != "length") errs += "길이 필드 '$lf' 의 타입은 length 여야 합니다."
                if (isBinaryLength() && def.lenOrZero() !in setOf(1, 2, 4)) errs += "binary 길이 필드의 len 은 1, 2, 4 중 하나여야 합니다."
            }
        }
        if (hasDiscriminator() && headerOrEmpty().none { it.nameOrEmpty() == discriminator!!.trim() }) errs += "헤더에 분기 필드 '${discriminator!!.trim()}' 가 없습니다."
        errs += checkTable("헤더", headerOrEmpty())
        val keys = HashSet<String>()
        for (m in messagesOrEmpty()) {
            val k = m.keyOrEmpty()
            if (k.isEmpty()) { errs += "전문 키가 비었습니다."; continue }
            if (!keys.add(k)) errs += "전문 키 중복: $k"
            if (!hasDiscriminator() && discValueOf(k) !in setOf("request", "response")) errs += "분기 필드 없이 전문 키는 request/response 만 가능합니다: $k"
            errs += checkTable("전문 $k", m.fieldsOrEmpty())
            if (headerLen() + m.bodyLen() > MAX_MESSAGE) errs += "전문 $k 총 길이가 상한(${MAX_MESSAGE}B)을 넘습니다."
        }
        return errs
    }

    private fun checkTable(where: String, fields: List<Field>): List<String> {
        val errs = ArrayList<String>()
        val names = HashSet<String>()
        for (f in fields) {
            val n = f.nameOrEmpty()
            if (n.isEmpty()) { errs += "$where: 이름 없는 필드가 있습니다."; continue }
            if (!names.add(n)) errs += "$where: 필드 이름 중복 '$n'"
            if (f.lenOrZero() <= 0) errs += "$where: '$n' 길이는 1 이상이어야 합니다."
            if (f.typeOr() !in TYPES) errs += "$where: '$n' 타입 '${f.typeOr()}' 은 지원하지 않습니다(length/string/ascii/numeric/binary)."
            if (f.padOr() !in PADS) errs += "$where: '$n' 패딩 '${f.padOr()}' 은 지원하지 않습니다(left/zero, right/space, left/space, none)."
        }
        return errs
    }

    companion object {
        const val MAX_MESSAGE = 1 shl 20
        val TYPES = setOf("length", "string", "ascii", "numeric", "binary")
        val PADS = setOf("left/zero", "right/space", "left/space", "none")
    }
}
