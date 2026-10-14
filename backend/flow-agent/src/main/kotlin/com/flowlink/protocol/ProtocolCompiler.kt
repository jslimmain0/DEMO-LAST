package com.flowlink.protocol

import com.flowlink.common.tcp.TcpBytes
import java.io.ByteArrayInputStream
import java.nio.charset.Charset
import com.fasterxml.jackson.databind.JsonNode

/** 화면·MCP·실행기가 공유하는 전송 없는 규격 검증과 조립. */
object ProtocolCompiler {
    data class ValidationError(val code: String, val path: String, val message: String, val repairHint: String = "해당 필드의 규격을 확인하세요.")
    class CompileException(val errors: List<ValidationError>) : IllegalArgumentException(errors.joinToString(" · ") { "${it.path}: ${it.message}" })
    class ProtocolFailure(val code: String, val path: String, message: String, val phase: String? = null, val expectedBytes: Int? = null, val actualBytes: Int? = null, val repairHint: String = "규격과 입력을 확인하세요.") : java.io.IOException(message)
    data class Preview(val bytes: ByteArray, val fields: List<ProtocolCodec.FieldSlice>, val values: Map<String, String>, val transactionKey: String?, val phase: String,
        val warnings: List<String> = emptyList(), val declaredLength: Int? = null, val lengthAdjustment: Int = 0)

    class Compiled(val spec: ProtocolSpec) {
        val schemaVersion = spec.schemaVersion ?: 1
        val requiredCapabilities: Set<String> = buildSet {
            if (!spec.transactions.isNullOrEmpty()) add("transactionFraming")
            val acks = spec.transactions.orEmpty().flatMap { listOfNotNull(it.requestAck, it.responseAck) }
            if (acks.isNotEmpty()) add("transactionAck")
            if (acks.any { it.receive?.kind == "length-only" }) add("ackLengthOnly")
            if (acks.any { it.send?.kind == "message" }) add("ackMessageTemplates")
            if (acks.any { it.receive?.kind == "fields" }) add("ackFieldValidation")
            if ((spec.headerOrEmpty() + spec.messagesOrEmpty().flatMap { it.fieldsOrEmpty() } + spec.ackMessages.orEmpty().flatMap { it.fields.orEmpty() }).any { it.typeOr() == "integer" }) add("binaryIntegers")
        }
        val summary: Map<String, Any?> get() = mapOf("headerBytes" to spec.headerLen(), "selectionFields" to spec.transactions.orEmpty().flatMap { it.`when`.orEmpty().map { c -> c.field } }.distinct(),
            "transactions" to spec.transactions.orEmpty().map { t -> mapOf("key" to t.key, "requestMessage" to t.requestMessage, "responseMessage" to t.responseMessage,
                "framing" to effectiveSpec(t).framing, "responseFraming" to effectiveSpec(t).responseFraming, "requestAck" to ackSummary(t.requestAck), "responseAck" to ackSummary(t.responseAck)) },
            "ackMessages" to spec.ackMessages.orEmpty().map { mapOf("key" to it.key, "lengthBytes" to it.length()) },
            "requiredPlugins" to pluginRefs(spec).mapNotNull { it.id }.distinct(), "secretNames" to pluginRefs(spec).flatMap { p -> p.configOrEmpty().values.flatMap { value -> Regex("\\{\\{\\s*([^{}]+?)@secret\\s*}}").findAll(value).map { it.groupValues[1].trim() }.toList() } }.distinct())
        fun transaction(key: String): ProtocolSpec.Transaction = spec.transactions.orEmpty().firstOrNull { it.key == key }
            ?: fail("UNKNOWN_TRANSACTION", "transactionKey", "등록되지 않은 거래입니다.")
        fun transactionForKey(key: String): ProtocolSpec.Transaction {
            val candidates = spec.transactions.orEmpty().filter { it.requestMessage == key || it.responseMessage == key }
            return unique(candidates)
        }
        fun select(header: Map<String, String>): ProtocolSpec.Transaction = unique(spec.transactions.orEmpty().filter { t -> t.`when`.orEmpty().all { c -> header[c.field] == c.value } })
        fun effectiveSpec(transaction: ProtocolSpec.Transaction): ProtocolSpec = spec.copy(framing = transaction.framing ?: spec.framing,
            responseFraming = transaction.responseFraming ?: spec.responseFraming ?: spec.framing)
        private fun unique(candidates: List<ProtocolSpec.Transaction>): ProtocolSpec.Transaction = when (candidates.size) {
            1 -> candidates.single()
            0 -> fail("UNKNOWN_TRANSACTION", "transactions", "헤더와 일치하는 거래가 없습니다.")
            else -> fail("AMBIGUOUS_TRANSACTION", "transactions", "둘 이상의 거래가 일치합니다.")
        }
    }

    fun compile(spec: ProtocolSpec): Compiled {
        val errors = errors(spec)
        if (errors.isNotEmpty()) throw CompileException(errors)
        return Compiled(spec)
    }

    /** v1의 느슨한 JSON 계약은 유지하고 v2는 역직렬화 전에 손실될 입력을 거절한다. */
    fun jsonErrors(spec: JsonNode): List<ValidationError> {
        if (spec.path("schemaVersion").asInt() != 2 && !spec.has("transactions") && !spec.has("ackMessages")) return emptyList()
        val errors = ArrayList<ValidationError>()
        fun error(path: String, message: String) { errors += ValidationError("INVALID_SCHEMA", path, message) }
        fun obj(node: JsonNode, path: String, allowed: Set<String>, required: Set<String> = emptySet()): Boolean {
            if (!node.isObject) { error(path, "객체여야 합니다."); return false }
            node.fieldNames().forEachRemaining { if (it !in allowed) error("$path.$it", "지원하지 않는 속성입니다.") }
            required.filterNot(node::has).forEach { error("$path.$it", "속성을 명시하세요(null은 단계 생략).") }
            return true
        }
        fun list(node: JsonNode, path: String, action: (JsonNode, String) -> Unit) {
            if (!node.isArray) { error(path, "배열이어야 합니다."); return }
            node.forEachIndexed { index, child -> action(child, "$path[$index]") }
        }
        fun integers(node: JsonNode, path: String, names: Set<String>) {
            names.filter { node.has(it) && !node[it].isNull && (!node[it].isIntegralNumber || !node[it].canConvertToInt()) }.forEach { error("$path.$it", "범위 내 정수여야 합니다.") }
        }
        fun frame(node: JsonNode, path: String) { if (!node.isNull && obj(node, path, setOf("mode", "lengthAdjustment", "fixedLength", "delimiterHex"))) integers(node, path, setOf("lengthAdjustment", "fixedLength")) }
        fun fields(node: JsonNode, path: String) = list(node, path) { field, where ->
            if (obj(field, where, setOf("name", "len", "type", "pad", "plugin", "endian", "signed"))) {
                integers(field, where, setOf("len"))
                if (field.has("signed") && !field["signed"].isBoolean && !field["signed"].isNull) error("$where.signed", "boolean이어야 합니다.")
                field.get("plugin")?.takeUnless { it.isNull }?.let { obj(it, "$where.plugin", setOf("id", "config")) }
            }
        }
        fun ack(node: JsonNode, path: String) {
            if (node.isNull || !obj(node, path, setOf("send", "receive", "timeoutMs"), setOf("send", "receive", "timeoutMs"))) return
            integers(node, path, setOf("timeoutMs"))
            node.get("send")?.let { obj(it, "$path.send", setOf("kind", "hex", "messageKey", "values")) }
            node.get("receive")?.let { if (obj(it, "$path.receive", setOf("kind", "hex", "lengthBytes", "messageKey", "expected"))) integers(it, "$path.receive", setOf("lengthBytes")) }
        }
        if (!obj(spec, "spec", setOf("encoding", "lengthField", "lengthFormat", "endian", "includesSelf", "discriminator", "header", "messages", "messagePlugins", "framing", "responseFraming", "transport", "schemaVersion", "transactions", "ackMessages", "binaryLength", "littleEndian", "isBinaryLength", "isLittleEndian"))) return errors
        if (!spec.path("schemaVersion").isIntegralNumber || spec.path("schemaVersion").asInt() != 2) error("schemaVersion", "거래 확장은 정수 schemaVersion: 2가 필요합니다.")
        if (spec.has("includesSelf") && !spec["includesSelf"].isNull && !spec["includesSelf"].isBoolean) error("includesSelf", "boolean이어야 합니다.")
        for ((name, expected) in mapOf("binaryLength" to (spec.path("lengthFormat").asText("").trim().lowercase() == "binary"), "littleEndian" to (spec.path("endian").asText("").trim().lowercase() == "little"))) {
            for (alias in listOf(name, "is${name.replaceFirstChar { it.uppercase() }}")) if (spec.has(alias) && (!spec[alias].isBoolean || spec[alias].asBoolean() != expected)) error(alias, "lengthFormat/endian에서 계산된 읽기 전용 boolean과 일치해야 합니다.")
        }
        spec.get("header")?.let { fields(it, "header") }
        spec.get("messages")?.let { list(it, "messages") { message, where -> if (obj(message, where, setOf("key", "label", "fields"))) message.get("fields")?.let { f -> fields(f, "$where.fields") } } }
        spec.get("ackMessages")?.takeUnless { it.isNull }?.let { list(it, "ackMessages") { message, where -> if (obj(message, where, setOf("key", "encoding", "fields"))) message.get("fields")?.let { f -> fields(f, "$where.fields") } } }
        spec.get("framing")?.let { frame(it, "framing") }; spec.get("responseFraming")?.let { frame(it, "responseFraming") }
        spec.get("transport")?.takeUnless { it.isNull }?.let { if (obj(it, "transport", setOf("connection", "requestAckHex", "responseAckHex", "idleTimeoutMs"))) integers(it, "transport", setOf("idleTimeoutMs")) }
        spec.get("messagePlugins")?.takeUnless { it.isNull }?.let { list(it, "messagePlugins") { plugin, where -> obj(plugin, where, setOf("id", "config")) } }
        spec.get("transactions")?.let { list(it, "transactions") { transaction, where ->
            if (obj(transaction, where, setOf("key", "when", "requestMessage", "responseMessage", "framing", "responseFraming", "requestAck", "responseAck"), setOf("requestAck", "responseAck"))) {
                transaction.get("when")?.let { list(it, "$where.when") { condition, cp -> obj(condition, cp, setOf("field", "op", "value")) } }
                transaction.get("framing")?.let { frame(it, "$where.framing") }; transaction.get("responseFraming")?.let { frame(it, "$where.responseFraming") }
                transaction.get("requestAck")?.let { ack(it, "$where.requestAck") }; transaction.get("responseAck")?.let { ack(it, "$where.responseAck") }
            }
        } }
        return errors
    }

    fun errors(spec: ProtocolSpec): List<ValidationError> {
        val errors = ArrayList<ValidationError>()
        fun error(path: String, message: String, code: String = "INVALID_SCHEMA") { errors += ValidationError(code, path, message) }
        if (spec.schemaVersion != null && spec.schemaVersion !in 1..2) error("schemaVersion", "지원 버전은 1, 2입니다.")
        if (spec.schemaVersion != 2) {
            if (spec.transactions != null || spec.ackMessages != null) error("schemaVersion", "거래와 ACK 레이아웃은 schemaVersion: 2가 필요합니다.")
            spec.validateLegacy().forEach { error("spec", it) }
            return errors
        }
        if (spec.encoding != null && !runCatching { Charset.isSupported(spec.encoding) }.getOrDefault(false)) error("encoding", "지원하지 않는 문자셋입니다.")
        if (spec.transactions.isNullOrEmpty()) error("transactions", "v2는 거래를 하나 이상 선언하세요.")
        if (spec.headerLen() <= 0) error("header", "거래 선택에 사용할 공통 헤더가 필요합니다.")
        if (!spec.transport?.requestAckHex.isNullOrBlank() || !spec.transport?.responseAckHex.isNullOrBlank()) error("transport", "v2 거래 ACK와 기존 HEX ACK를 함께 지정할 수 없습니다.")
        val txKeys = HashSet<String>()
        val ackKeys = HashSet<String>()
        for ((index, message) in spec.ackMessages.orEmpty().withIndex()) {
            val path = "ackMessages[$index]"
            if (message.key.isNullOrBlank() || !ackKeys.add(message.key)) error("$path.key", "ACK 전문 키가 비었거나 중복됩니다.")
            if (message.length() !in 1..1024) error("$path.fields", "ACK 레이아웃은 1~1024B여야 합니다.")
            val check = ProtocolSpec(schemaVersion = 2, framing = ProtocolSpec.Framing("fixed", fixedLength = maxOf(1, message.length())), messages = listOf(ProtocolSpec.Message("request", fields = message.fields)))
            check.validateLegacy().forEach { error(path, it) }
            if (message.fields.orEmpty().any { it.typeOr() == "length" }) error("$path.fields", "독립 ACK 레이아웃은 자동 업무 길이 필드를 사용하지 않습니다.")
            if (message.encoding != null && runCatching { Charset.isSupported(message.encoding) }.getOrDefault(false).not()) error("$path.encoding", "지원하지 않는 문자셋입니다.")
        }
        val compiled = Compiled(spec)
        for ((index, tx) in spec.transactions.orEmpty().withIndex()) {
            val path = "transactions[$index]"
            if (tx.key.isNullOrBlank() || !txKeys.add(tx.key)) error("$path.key", "거래 키가 비었거나 중복됩니다.")
            if (tx.`when`.isNullOrEmpty()) error("$path.when", "헤더 eq 조건을 하나 이상 지정하세요.")
            val conditionFields = HashSet<String>()
            for ((ci, condition) in tx.`when`.orEmpty().withIndex()) {
                if (condition.op != "eq" || condition.value == null || spec.headerOrEmpty().none { it.nameOrEmpty() == condition.field }) error("$path.when[$ci]", "실제 헤더 필드의 eq 조건과 값을 지정하세요.")
                if (spec.headerOrEmpty().any { it.nameOrEmpty() == condition.field && it.plugin != null }) error("$path.when[$ci]", "거래 식별 필드는 평문 공통 헤더를 사용하세요.")
                if (!conditionFields.add(condition.field.orEmpty())) error("$path.when[$ci]", "동일 헤더 필드 조건이 중복됩니다.")
            }
            for ((name, key) in listOf("requestMessage" to tx.requestMessage, "responseMessage" to tx.responseMessage)) if (key.isNullOrBlank() || spec.message(key) == null) error("$path.$name", "등록된 업무 전문 키를 지정하세요.")
            val effective = compiled.effectiveSpec(tx)
            if (effective.framing == null) error("$path.framing", "요청 프레이밍을 명시하세요.")
            if (effective.responseFraming == null) error("$path.responseFraming", "응답 프레이밍을 명시하세요.")
            effective.validateLegacy().forEach { error(path, it) }
            for ((direction, key) in listOf(Direction.SEND to tx.requestMessage, Direction.RECV to tx.responseMessage)) {
                val frame = effective.framingFor(direction)
                if (frame?.modeOr() == "fixed" && spec.message(key.orEmpty()) != null && spec.messagePlugins.isNullOrEmpty() && frame.fixedLength != spec.totalLen(key.orEmpty())) error("$path.${if (direction == Direction.SEND) "framing" else "responseFraming"}", "고정 길이가 헤더+본문 길이와 다릅니다.", "FRAME_LENGTH_MISMATCH")
            }
            for ((phase, ack) in listOf("requestAck" to tx.requestAck, "responseAck" to tx.responseAck)) {
                ack ?: continue
                val ap = "$path.$phase"
                if (ack.timeoutMs == null || ack.timeoutMs !in 1..120_000) error("$ap.timeoutMs", "ACK 제한은 1~120000ms로 명시하세요.")
                if (ack.send?.kind == "hex" && (ack.send.messageKey != null || ack.send.values != null) || ack.send?.kind == "message" && ack.send.hex != null) error("$ap.send", "ACK 송신 방식에 맞는 속성만 지정하세요.")
                if (ack.receive?.let { when (it.kind) { "exact" -> it.lengthBytes != null || it.messageKey != null || it.expected != null; "length-only" -> it.hex != null || it.messageKey != null || it.expected != null; "fields" -> it.hex != null || it.lengthBytes != null; else -> false } } == true) error("$ap.receive", "ACK 수신 방식에 맞는 속성만 지정하세요.")
                val sendLength = when (ack.send?.kind) {
                    "hex" -> TcpBytes.hexToBytes(ack.send.hex.orEmpty())?.size
                    "message" -> spec.ackMessages.orEmpty().firstOrNull { it.key == ack.send.messageKey }?.length()
                    else -> null
                }
                val receiveLength = when (ack.receive?.kind) {
                    "exact" -> TcpBytes.hexToBytes(ack.receive.hex.orEmpty())?.size
                    "length-only" -> ack.receive.lengthBytes
                    "fields" -> spec.ackMessages.orEmpty().firstOrNull { it.key == ack.receive.messageKey }?.length()
                    else -> null
                }
                if (sendLength == null || sendLength !in 1..1024) error("$ap.send", "hex 또는 등록된 message 송신 정의가 필요합니다.")
                if (receiveLength == null || receiveLength !in 1..1024) error("$ap.receive", "exact, length-only, fields 수신 정의가 필요합니다.")
                if (sendLength != null && receiveLength != null && sendLength != receiveLength) error(ap, "송신 ACK와 수신 계약 길이가 다릅니다.")
                val sendMessage = spec.ackMessages.orEmpty().firstOrNull { it.key == ack.send?.messageKey }
                if (ack.send?.kind == "message") {
                    val names = sendMessage?.fields.orEmpty().map { it.nameOrEmpty() }.toSet()
                    if (ack.send.values.orEmpty().keys != names) error("$ap.send.values", "ACK 레이아웃의 모든 필드를 한 번씩 지정하세요.")
                }
                if (ack.receive?.kind == "fields") {
                    val names = spec.ackMessages.orEmpty().firstOrNull { it.key == ack.receive.messageKey }?.fields.orEmpty().map { it.nameOrEmpty() }
                    if (ack.receive.expected.isNullOrEmpty() || ack.receive.expected.keys.any { it !in names }) error("$ap.receive.expected", "비교할 ACK 필드를 하나 이상 지정하세요.")
                }
                for ((name, value) in ack.send?.values.orEmpty() + ack.receive?.expected.orEmpty()) {
                    if (binding.replace(value, "").contains("{{")) error("$ap.$name", "ACK 템플릿은 req/res 업무 필드만 참조할 수 있습니다.")
                    for (ref in binding.findAll(value)) {
                        val scope = ref.groupValues[1]; val field = ref.groupValues[2]
                        if (scope == "res" && phase == "requestAck") error("$ap.$name", "요청 ACK는 아직 없는 응답을 참조할 수 없습니다.")
                        val message = spec.message((if (scope == "req") tx.requestMessage else tx.responseMessage).orEmpty())
                        if ((spec.headerOrEmpty() + message?.fieldsOrEmpty().orEmpty()).none { it.nameOrEmpty() == field }) error("$ap.$name", "참조하는 업무 필드가 없습니다.", "MISSING_CONTEXT_FIELD")
                    }
                }
            }
        }
        val transactions = spec.transactions.orEmpty()
        for (i in transactions.indices) for (j in i + 1 until transactions.size) {
            val first = transactions[i].`when`.orEmpty().associate { it.field to it.value }
            val second = transactions[j].`when`.orEmpty().associate { it.field to it.value }
            if (first.keys.intersect(second.keys).none { first[it] != second[it] }) error("transactions[$j].when", "다른 거래와 동시에 일치할 수 있는 조건입니다.", "AMBIGUOUS_TRANSACTION")
        }
        return errors.distinct()
    }

    fun assemble(spec: ProtocolSpec, key: String? = null, values: Map<String, String> = emptyMap(), transactionKey: String? = null, phase: String = "request",
        requestFields: Map<String, String> = emptyMap(), responseFields: Map<String, String> = emptyMap(), plugins: ProtocolCodec.PluginLookup = ProtocolCodec.NO_PLUGINS,
        resolve: (String) -> String = { it }, direction: Direction = Direction.SEND): Preview {
        val plan = compile(spec)
        val tx = choose(plan, key, transactionKey, phase)
        if (phase.endsWith("Ack")) {
            val ack = ackFor(tx!!, phase) ?: fail("INVALID_SCHEMA", phase, "생략된 ACK 단계입니다.")
            val encoded = assembleAck(spec, ack, requestFields, responseFields, plugins, resolve, direction)
            return Preview(encoded.bytes, encoded.fields, encoded.fields.associate { it.name to it.value }, tx.key, phase)
        }
        val frameDirection = phaseDirection(phase)
        val selected = tx?.let(plan::effectiveSpec) ?: spec
        val selectedKey = key ?: (if (phase == "request") tx?.requestMessage else tx?.responseMessage) ?: fail("INVALID_SCHEMA", "key", "전문 키가 필요합니다.")
        val all = LinkedHashMap(values)
        if (phase == "request") tx?.`when`?.forEach { condition ->
            val field = condition.field!!
            if (all[field] == null) all[field] = condition.value!!
            if (selected.lengthField != field && all[field] != condition.value) fail("UNKNOWN_TRANSACTION", "values.$field", "선택한 거래의 헤더 조건과 다릅니다.")
        }
        if (spec.schemaVersion == 2) for (field in selected.headerOrEmpty() + selected.message(selectedKey)!!.fieldsOrEmpty()) {
            if (field.typeOr() != "length" && field.nameOrEmpty() !in all) fail("MISSING_CONTEXT_FIELD", "values.${field.nameOrEmpty()}", "필수 필드가 없습니다.")
        }
        val encoded = ProtocolCodec.encode(selected, selectedKey, all, direction, plugins, resolve = resolve, frameDirection = frameDirection)
        if (phase == "request" && tx != null && plan.select(header(spec, encoded.bytes, plugins, resolve)).key != tx.key) fail("UNKNOWN_TRANSACTION", "values", "조립된 헤더가 선택 거래와 다릅니다.")
        return Preview(encoded.bytes, encoded.fields, encoded.fields.associate { it.name to it.value }, tx?.key, phase, encoded.warnings,
            if (selected.lengthFieldDef() != null) ProtocolCodec.parseLength(selected, encoded.bytes) else null, selected.lengthAdjustment(frameDirection))
    }

    fun parse(spec: ProtocolSpec, bytes: ByteArray, key: String? = null, transactionKey: String? = null, phase: String = "request",
        requestFields: Map<String, String> = emptyMap(), responseFields: Map<String, String> = emptyMap(), plugins: ProtocolCodec.PluginLookup = ProtocolCodec.NO_PLUGINS,
        resolve: (String) -> String = { it }, direction: Direction = Direction.RECV): Preview {
        if (bytes.isEmpty() || bytes.size > ProtocolSpec.MAX_MESSAGE) fail("FRAME_LENGTH_MISMATCH", "bytesB64", "바이트 길이가 유효하지 않습니다.")
        val plan = compile(spec)
        val selectedTx = if (spec.schemaVersion == 2 && transactionKey == null && key == null && phase == "request") plan.select(header(spec, bytes, plugins, resolve)) else choose(plan, key, transactionKey, phase)
        if (phase.endsWith("Ack")) {
            val ack = ackFor(selectedTx!!, phase) ?: fail("INVALID_SCHEMA", phase, "생략된 ACK 단계입니다.")
            val parsed = validateAck(spec, ack, bytes, requestFields, responseFields, plugins, resolve, direction)
            return Preview(bytes, parsed.second, parsed.first, selectedTx.key, phase)
        }
        val frameDirection = phaseDirection(phase)
        val selected = selectedTx?.let(plan::effectiveSpec) ?: spec
        val selectedKey = key ?: (if (phase == "request") selectedTx?.requestMessage else selectedTx?.responseMessage)
        val stream = ByteArrayInputStream(bytes)
        val frame = try { Framer.readFrame(stream, selected, frameDirection) } catch (_: Framer.FrameException) { fail("FRAME_LENGTH_MISMATCH", "bytesB64", "바이트가 완전한 전문이 아닙니다.") }
        if (frame == null || stream.available() != 0) fail("FRAME_LENGTH_MISMATCH", "bytesB64", "정확히 한 개의 완전한 전문이 필요합니다.")
        val decoded = ProtocolCodec.decode(selected, bytes, direction, plugins, resolve, selectedKey, frameDirection)
        if (selectedTx != null && phase == "request" && plan.select(decoded.header).key != selectedTx.key) fail("UNKNOWN_TRANSACTION", "transactionKey", "수신 헤더와 선택 거래가 다릅니다.")
        return Preview(bytes, decoded.fields, decoded.values(), selectedTx?.key, phase, decoded.warnings,
            if (selected.lengthFieldDef() != null) ProtocolCodec.parseLength(selected, bytes) else null, selected.lengthAdjustment(frameDirection))
    }

    fun header(spec: ProtocolSpec, bytes: ByteArray, plugins: ProtocolCodec.PluginLookup = ProtocolCodec.NO_PLUGINS, resolve: (String) -> String = { it }, selectionOnly: Boolean = false): Map<String, String> {
        if (bytes.size < spec.headerLen()) fail("FRAME_LENGTH_MISMATCH", "header", "공통 헤더가 불완전합니다.")
        if (selectionOnly) {
            val names = spec.transactions.orEmpty().flatMap { it.`when`.orEmpty().map { condition -> condition.field } }.toSet()
            val values = LinkedHashMap<String, String>()
            var offset = 0
            for (field in spec.headerOrEmpty()) {
                if (field.nameOrEmpty() in names) {
                    values[field.nameOrEmpty()] = if (field.typeOr() == "length") ProtocolCodec.parseLength(spec, bytes).toString()
                    else ProtocolCodec.decodeFields(listOf(field), bytes.copyOfRange(offset, offset + field.lenOrZero()), spec.encoding ?: "EUC-KR", plugins, resolve = resolve).first.getValue(field.nameOrEmpty())
                }
                offset += field.lenOrZero()
            }
            return values
        }
        val fields = spec.headerOrEmpty().map { if (it.typeOr() == "length") it.copy(type = if (spec.isBinaryLength()) "integer" else "ascii", endian = spec.endian ?: "big", signed = false) else it }
        val values = ProtocolCodec.decodeFields(fields, bytes.copyOf(spec.headerLen()), spec.encoding ?: "EUC-KR", plugins, resolve = resolve).first
        spec.lengthField?.let { values[it] = ProtocolCodec.parseLength(spec, bytes).toString() }
        return values
    }

    fun assembleAck(spec: ProtocolSpec, ack: ProtocolSpec.Ack, request: Map<String, String>, response: Map<String, String>, plugins: ProtocolCodec.PluginLookup = ProtocolCodec.NO_PLUGINS, resolve: (String) -> String = { it }, direction: Direction = Direction.SEND): ProtocolCodec.Encoded = when (ack.send?.kind) {
        "hex" -> ProtocolCodec.Encoded(TcpBytes.hexToBytes(ack.send.hex.orEmpty()) ?: fail("INVALID_SCHEMA", "ack.send.hex", "ACK HEX가 유효하지 않습니다."), emptyList(), emptyList())
        "message" -> {
            val message = spec.ackMessages.orEmpty().first { it.key == ack.send.messageKey }
            ProtocolCodec.encodeFields(message.fields.orEmpty(), ack.send.values.orEmpty().mapValues { bind(it.value, request, response) }, message.encoding ?: spec.encoding ?: "EUC-KR", plugins, direction, resolve)
        }
        else -> fail("INVALID_SCHEMA", "ack.send", "ACK 송신 방식이 없습니다.")
    }

    fun ackLength(spec: ProtocolSpec, ack: ProtocolSpec.Ack): Int = when (ack.receive?.kind) {
        "exact" -> TcpBytes.hexToBytes(ack.receive.hex.orEmpty())!!.size
        "length-only" -> ack.receive.lengthBytes!!
        "fields" -> spec.ackMessages.orEmpty().first { it.key == ack.receive.messageKey }.length()
        else -> fail("INVALID_SCHEMA", "ack.receive", "ACK 수신 방식이 없습니다.")
    }

    fun validateAck(spec: ProtocolSpec, ack: ProtocolSpec.Ack, bytes: ByteArray, request: Map<String, String>, response: Map<String, String>, plugins: ProtocolCodec.PluginLookup = ProtocolCodec.NO_PLUGINS, resolve: (String) -> String = { it }, direction: Direction = Direction.RECV): Pair<Map<String, String>, List<ProtocolCodec.FieldSlice>> {
        if (bytes.size != ackLength(spec, ack)) fail("ACK_MISMATCH", "ack.receive", "ACK 길이가 다릅니다.")
        when (ack.receive?.kind) {
            "exact" -> if (!bytes.contentEquals(TcpBytes.hexToBytes(ack.receive.hex.orEmpty()))) fail("ACK_MISMATCH", "ack.receive.hex", "ACK 바이트가 일치하지 않습니다.")
            "fields" -> {
                val message = spec.ackMessages.orEmpty().first { it.key == ack.receive.messageKey }
                val parsed = ProtocolCodec.decodeFields(message.fields.orEmpty(), bytes, message.encoding ?: spec.encoding ?: "EUC-KR", plugins, direction, resolve)
                for ((name, template) in ack.receive.expected.orEmpty()) {
                    val field = message.fields.orEmpty().first { it.nameOrEmpty() == name }
                    val expected = ProtocolCodec.encodeFields(message.fields.orEmpty(), parsed.first + (name to bind(template, request, response)), message.encoding ?: spec.encoding ?: "EUC-KR", plugins, Direction.SEND, resolve)
                    val offset = parsed.second.first { it.name == name }.offset
                    if (!bytes.copyOfRange(offset, offset + field.lenOrZero()).contentEquals(expected.bytes.copyOfRange(offset, offset + field.lenOrZero()))) fail("ACK_MISMATCH", "ack.receive.expected.$name", "ACK 필드가 일치하지 않습니다.")
                }
                return parsed
            }
        }
        return emptyMap<String, String>() to emptyList()
    }

    fun bind(value: String, request: Map<String, String>, response: Map<String, String>): String = binding.replace(value) { match ->
        val source = if (match.groupValues[1] == "req") request else response
        source[match.groupValues[2]] ?: fail("MISSING_CONTEXT_FIELD", "${match.groupValues[1]}.${match.groupValues[2]}", "필수 컨텍스트 필드가 없습니다.")
    }
    fun pluginRefs(spec: ProtocolSpec): List<ProtocolSpec.PluginRef> = spec.messagePlugins.orEmpty() + (spec.headerOrEmpty() + spec.messagesOrEmpty().flatMap { it.fieldsOrEmpty() } + spec.ackMessages.orEmpty().flatMap { it.fields.orEmpty() }).mapNotNull { it.plugin }
    private fun choose(plan: Compiled, key: String?, transactionKey: String?, phase: String): ProtocolSpec.Transaction? {
        if (plan.schemaVersion != 2) { if (transactionKey != null || phase.endsWith("Ack")) fail("INVALID_SCHEMA", "transactionKey", "ACK 거래 선택에는 v2가 필요합니다."); return null }
        if (phase.endsWith("Ack") && transactionKey == null) fail("INVALID_SCHEMA", "transactionKey", "ACK 단계는 거래 키가 필요합니다.")
        val tx = transactionKey?.let(plan::transaction) ?: key?.let(plan::transactionForKey) ?: fail("INVALID_SCHEMA", "transactionKey", "거래 또는 전문 키가 필요합니다.")
        val expected = if (phase == "request") setOf(tx.requestMessage) else if (phase == "response") setOf(tx.responseMessage) else ackFor(tx, phase)?.let { setOf(it.send?.messageKey, it.receive?.messageKey) }.orEmpty()
        if (key != null && key !in expected) fail("INVALID_SCHEMA", "key", "전문 키와 거래 단계가 다릅니다.")
        return tx
    }
    fun ackFor(transaction: ProtocolSpec.Transaction, phase: String): ProtocolSpec.Ack? = when (phase) { "requestAck" -> transaction.requestAck; "responseAck" -> transaction.responseAck; else -> fail("INVALID_SCHEMA", "phase", "유효한 ACK 단계가 아닙니다.") }
    private fun phaseDirection(phase: String): Direction = when (phase) { "request" -> Direction.SEND; "response" -> Direction.RECV; else -> fail("INVALID_SCHEMA", "phase", "request/response/requestAck/responseAck 중 하나를 사용하세요.") }
    private fun ackSummary(ack: ProtocolSpec.Ack?): Map<String, Any?>? = ack?.let { mapOf("send" to it.send?.kind, "receive" to it.receive?.kind, "timeoutMs" to it.timeoutMs) }
    private val binding = Regex("\\{\\{\\s*(req|res)\\.([^{}\\s]+)\\s*}}")
    private fun fail(code: String, path: String, message: String): Nothing = throw ProtocolFailure(code, path, message)
}
