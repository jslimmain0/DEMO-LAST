package com.flowlink.protocol

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonInclude
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
    val lengthFormat: String? = null,      // ascii-decimal(기본) | ascii-hex | binary
    val endian: String? = null,            // big(기본) | little — binary 일 때만
    val includesSelf: Boolean? = null,     // 길이값에 길이 필드 자신 포함(true=전체, false=전체-길이필드len)
    val discriminator: String? = null,     // 본문 표를 고르는 헤더 필드. 비면 request/response
    val header: List<Field>? = null,
    val messages: List<Message>? = null,   // 순서 있음(UI 탭)
    val messagePlugins: List<PluginRef>? = null,
    @get:JsonInclude(JsonInclude.Include.NON_NULL) val framing: Framing? = null,
    @get:JsonInclude(JsonInclude.Include.NON_NULL) val responseFraming: Framing? = null,
    @get:JsonInclude(JsonInclude.Include.NON_NULL) val transport: Transport? = null,
    @get:JsonInclude(JsonInclude.Include.NON_NULL) val schemaVersion: Int? = null,
    @get:JsonInclude(JsonInclude.Include.NON_NULL) val transactions: List<Transaction>? = null,
    @get:JsonInclude(JsonInclude.Include.NON_NULL) val ackMessages: List<AckMessage>? = null,
) {
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class Transaction(val key: String? = null, val `when`: List<Selection>? = null,
        val requestMessage: String? = null, val responseMessage: String? = null,
        val framing: Framing? = null, val responseFraming: Framing? = null,
        val requestAck: Ack? = null, val responseAck: Ack? = null)
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class Selection(val field: String? = null, val op: String? = null, val value: String? = null)
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class Ack(val send: AckSend? = null, val receive: AckReceive? = null, val timeoutMs: Int? = null)
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class AckSend(val kind: String? = null, val hex: String? = null, val messageKey: String? = null, val values: Map<String, String>? = null)
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class AckReceive(val kind: String? = null, val hex: String? = null, val lengthBytes: Int? = null, val messageKey: String? = null, val expected: Map<String, String>? = null)
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class AckMessage(val key: String? = null, val encoding: String? = null, val fields: List<Field>? = null) {
        fun length(): Int = fields.orEmpty().sumOf { it.lenOrZero().toLong() }.coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
    }
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class Framing(
        val mode: String? = null,
        val lengthAdjustment: Int? = null,
        val fixedLength: Int? = null,
        val delimiterHex: String? = null,
    ) {
        fun modeOr(): String = mode?.trim()?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() } ?: "length"
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class Transport(val connection: String? = null, val requestAckHex: String? = null, val responseAckHex: String? = null, val idleTimeoutMs: Int? = null) {
        fun connectionOr(): String = connection?.trim()?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() } ?: "once"
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class Field(
        val name: String? = null,
        val len: Int? = null,
        val type: String? = null,          // length | string | ascii | numeric | binary
        val pad: String? = null,           // left/zero | right/space | left/space | none
        val plugin: PluginRef? = null,
        @get:JsonInclude(JsonInclude.Include.NON_NULL) val endian: String? = null,
        @get:JsonInclude(JsonInclude.Include.NON_NULL) val signed: Boolean? = null,
    ) {
        fun nameOrEmpty(): String = name?.trim().orEmpty()
        fun lenOrZero(): Int = len ?: 0
        fun typeOr(): String = (type ?: "string").trim().lowercase(Locale.ROOT).ifEmpty { "string" }
        fun padOr(): String = pad?.trim()?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() }
            ?: when (typeOr()) { "numeric", "length" -> "left/zero"; "binary", "integer" -> "none"; else -> "right/space" }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class Message(val key: String? = null, val label: String? = null, val fields: List<Field>? = null) {
        fun keyOrEmpty(): String = key?.trim().orEmpty()
        fun fieldsOrEmpty(): List<Field> = fields ?: emptyList()
        fun bodyLen(): Int = fieldsOrEmpty().sumOf { it.lenOrZero().toLong() }.coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class PluginRef(val id: String? = null, val config: Map<String, String>? = null) {
        fun configOrEmpty(): Map<String, String> = config ?: emptyMap()
    }

    fun charset(): Charset = TcpBytes.charset(encoding, Charset.forName("EUC-KR"))
    fun headerOrEmpty(): List<Field> = header ?: emptyList()
    fun messagesOrEmpty(): List<Message> = messages ?: emptyList()
    fun headerLen(): Int = headerOrEmpty().sumOf { it.lenOrZero().toLong() }.coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
    fun framingFor(direction: Direction): Framing? = if (direction == Direction.RECV) responseFraming ?: framing else framing
    fun framingMode(direction: Direction): String = framingFor(direction)?.modeOr() ?: "length"
    fun lengthAdjustment(direction: Direction): Int = framingFor(direction)?.lengthAdjustment
        ?: if (includesSelf == true) 0 else lengthFieldDef()?.lenOrZero() ?: 0
    fun delimiterBytes(direction: Direction): ByteArray? = framingFor(direction)?.delimiterHex?.let(TcpBytes::hexToBytes)
    fun lengthFormatOr(): String = lengthFormat?.trim()?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() } ?: "ascii-decimal"
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
    fun totalLen(key: String): Int = (headerLen().toLong() + (message(key)?.bodyLen() ?: 0)).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()

    fun validate(): List<String> {
        if (schemaVersion != null && schemaVersion != 1 && schemaVersion != 2) return listOf("지원하지 않는 schemaVersion입니다.")
        if (schemaVersion == 2 || transactions != null || ackMessages != null) return ProtocolCompiler.errors(this).map { "${it.path}: ${it.message}" }
        return validateLegacy()
    }

    internal fun validateLegacy(): List<String> {
        val errs = ArrayList<String>()
        val lf = lengthField?.trim().orEmpty()
        val requiresLength = listOf(Direction.SEND, Direction.RECV).any { framingMode(it) == "length" }
        if (lf.isEmpty() && requiresLength) errs += "길이 필드(lengthField)를 지정하세요."
        else if (lf.isNotEmpty()) {
            val def = lengthFieldDef()
            if (def == null) errs += "헤더에 길이 필드 '$lf' 가 없습니다."
            else {
                if (def.typeOr() != "length") errs += "길이 필드 '$lf' 의 타입은 length 여야 합니다."
                if (isBinaryLength() && def.lenOrZero() !in setOf(1, 2, 4, 8)) errs += "binary 길이 필드의 len 은 1, 2, 4, 8 중 하나여야 합니다."
            }
        }
        if (lengthFormatOr() !in setOf("ascii-decimal", "ascii-hex", "binary")) errs += "길이 형식은 ascii-decimal, ascii-hex, binary 중 하나여야 합니다."
        if (!endian.isNullOrBlank() && endian.trim().lowercase(Locale.ROOT) !in setOf("big", "little")) errs += "바이트 순서는 big 또는 little 이어야 합니다."
        if (headerLen() > MAX_MESSAGE) errs += "헤더 길이가 상한(${MAX_MESSAGE}B)을 넘습니다."
        for (direction in listOf(Direction.SEND, Direction.RECV)) {
            val frame = framingFor(direction) ?: continue
            val where = if (direction == Direction.SEND) "요청" else "응답"
            when (frame.modeOr()) {
                "length" -> if (frame.lengthAdjustment != null && frame.lengthAdjustment !in -MAX_MESSAGE..MAX_MESSAGE) errs += "$where 길이 보정은 -${MAX_MESSAGE}~${MAX_MESSAGE}B 범위여야 합니다."
                "fixed" -> if (frame.fixedLength == null || frame.fixedLength !in maxOf(1, headerLen())..MAX_MESSAGE) errs += "$where 고정 길이는 헤더 이상, 1~${MAX_MESSAGE}B 범위여야 합니다."
                "delimiter" -> {
                    val delimiter = delimiterBytes(direction)
                    if (delimiter == null || delimiter.size !in 1..64) errs += "$where 구분자는 1~64바이트 HEX 형식이어야 합니다."
                }
                else -> errs += "$where 프레이밍은 length, fixed, delimiter 중 하나여야 합니다."
            }
        }
        transport?.let {
            if (it.connectionOr() !in setOf("once", "execution")) errs += "연결 방식은 once 또는 execution 이어야 합니다."
            if (it.idleTimeoutMs != null && it.idleTimeoutMs !in 1000..3_600_000) errs += "유휴 연결 제한은 1,000~3,600,000ms 범위여야 합니다."
            for ((name, hex) in listOf("요청 ACK" to it.requestAckHex, "응답 ACK" to it.responseAckHex)) {
                if (!hex.isNullOrBlank()) {
                    val bytes = TcpBytes.hexToBytes(hex)
                    if (bytes == null || bytes.size !in 1..1024) errs += "$name 는 1~1024바이트 HEX 형식이어야 합니다."
                }
            }
        }
        if (hasDiscriminator() && headerOrEmpty().none { it.nameOrEmpty() == discriminator!!.trim() }) errs += "헤더에 분기 필드 '${discriminator!!.trim()}' 가 없습니다."
        errs += checkTable("헤더", headerOrEmpty())
        val keys = HashSet<String>()
        for (m in messagesOrEmpty()) {
            val k = m.keyOrEmpty()
            if (k.isEmpty()) { errs += "전문 키가 비었습니다."; continue }
            if (!keys.add(k)) errs += "전문 키 중복: $k"
            if (schemaVersion != 2 && !hasDiscriminator() && discValueOf(k) !in setOf("request", "response")) errs += "분기 필드 없이 전문 키는 request/response 만 가능합니다: $k"
            errs += checkTable("전문 $k", m.fieldsOrEmpty())
            // 헤더+본문을 한 맵으로 합쳐 쓰므로(템플릿·조건·출력) 같은 이름이면 어느 값인지 모호해진다
            val headerNames = headerOrEmpty().mapTo(HashSet()) { it.nameOrEmpty() }
            for (f in m.fieldsOrEmpty()) {
                val n = f.nameOrEmpty()
                if (n.isNotEmpty() && n in headerNames) errs += "전문 $k: '$n' 은 헤더 필드와 이름이 겹칩니다."
            }
            if (headerLen().toLong() + m.bodyLen() > MAX_MESSAGE) errs += "전문 $k 총 길이가 상한(${MAX_MESSAGE}B)을 넘습니다."
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
            if (f.lenOrZero() !in 1..MAX_MESSAGE) errs += "$where: '$n' 길이는 1~${MAX_MESSAGE}B 범위여야 합니다."
            if (f.typeOr() !in TYPES) errs += "$where: '$n' 타입 '${f.typeOr()}' 은 지원하지 않습니다(length/string/ascii/numeric/binary)."
            if (f.padOr() !in PADS) errs += "$where: '$n' 패딩 '${f.padOr()}' 은 지원하지 않습니다(left/zero, right/space, left/space, none)."
            if (f.typeOr() == "integer" && (f.lenOrZero() !in setOf(1, 2, 4, 8) || f.endian !in setOf("big", "little") || f.signed == null)) errs += "$where: '$n' integer는 길이 1/2/4/8, endian, signed를 명시하세요."
        }
        return errs
    }

    companion object {
        const val MAX_MESSAGE = 1 shl 20
        val TYPES = setOf("length", "string", "ascii", "numeric", "binary", "integer")
        val PADS = setOf("left/zero", "right/space", "left/space", "none", "right/nul", "left/nul")
    }
}
