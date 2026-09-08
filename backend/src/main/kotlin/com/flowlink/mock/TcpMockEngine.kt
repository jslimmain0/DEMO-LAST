package com.flowlink.mock

import com.flowlink.common.tcp.TcpBytes
import com.flowlink.mock.MockSpec.MockTcp
import com.flowlink.mock.MockSpec.MockTcpCond
import com.flowlink.mock.MockSpec.MockTcpRule
import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.util.Locale
import java.util.UUID
import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * TCP mock 순수 엔진 — 요청 전문 필드 슬라이싱 · 규칙 매칭(contains + 필드 조건) · 응답 조립(텍스트 템플릿 또는 필드별 바이트).
 * 소켓/스레드 없음(리스너·미리보기 API 공용). 길이는 전부 바이트(TcpBytes).
 */
object TcpMockEngine {

    /** 요청 전문을 레이아웃대로 자른 필드 값. */
    data class ReqField(val name: String, val offset: Int, val length: Int, val value: String, val encoding: String)

    /** 응답 조립 결과 — 프리픽스 제외 본문 + 필드별 정보(필드 모드일 때). */
    class Rendered(val body: ByteArray, val fields: List<RespSlice>)

    data class RespSlice(
        val name: String?, val offset: Int, val declaredLen: Int, val actualBytes: Int,
        val truncated: Boolean, val padded: Boolean, val pad: String, val text: String, val encoding: String,
    )

    /** 미리보기(저장·소켓 없음): 샘플 요청 → 필드 분해 + 매칭 규칙 + 응답 hex/텍스트/필드. */
    data class Preview(
        val encoding: String,
        val requestFields: List<ReqField>,
        val requestBytes: Int,
        val matchedRuleId: String?,
        val matchedRuleIndex: Int?,
        val totalBytes: Int,
        val prefixLen: Int,
        val declaredPrefix: Int?,
        val bodyBytes: Int,
        val hex: String,
        val printable: String,
        val fields: List<RespSlice>,
    )

    const val MAX_FIELD_TOTAL = 1 shl 20 // 1MB — ByteArray(length) 직접 할당 가드(미리보기 API 가 임의 spec 을 받음)

    // {{req}} · {{req:오프셋:길이}} · {{req.필드명}} · {{seq}} · {{now}} · {{uuid}}
    private val TOKEN: Pattern = Pattern.compile("\\{\\{\\s*(req(?::(\\d+):(\\d+))?|req\\.([^\\s}]+)|seq|now|uuid)\\s*}}")

    @JvmStatic
    fun charsetOf(name: String?): Charset = TcpBytes.charset(name, Charset.forName("EUC-KR"))

    /** 요청 전문 → 레이아웃 필드 값(오프셋 누적, 범위 초과는 빈 값/부분). */
    @JvmStatic
    fun sliceRequest(tcp: MockTcp?, req: ByteArray, cs: Charset): List<ReqField> {
        val out = ArrayList<ReqField>()
        var offset = 0
        for (f in tcp?.requestFieldsOrEmpty() ?: emptyList()) {
            val len = maxOf(f.length ?: 0, 0)
            val fcs = TcpBytes.charset(f.encoding, cs)
            val value = String(TcpBytes.slice(req, offset, len), fcs)
            out.add(ReqField(f.name?.trim().orEmpty(), offset, len, value, fcs.name()))
            offset += len
        }
        return out
    }

    /** contains(디코딩 전문) AND 필드 조건 모두 만족하는 첫 규칙. */
    @JvmStatic
    fun matchRule(rules: List<MockTcpRule>, text: String, reqFields: List<ReqField>): MockTcpRule? {
        val byName = reqFields.associate { it.name to it.value }
        return rules.firstOrNull { r ->
            (r.contains.isNullOrEmpty() || text.contains(r.contains)) && r.whenOrEmpty().all { condPass(it, byName) }
        }
    }

    private fun condPass(c: MockTcpCond, byName: Map<String, String>): Boolean {
        val field = c.field?.trim().orEmpty()
        if (field.isEmpty()) return true // 미완성 조건은 무시(편집 중)
        val actual = byName[field]?.trim() ?: return false
        val v = c.value ?: ""
        return when (c.op?.lowercase(Locale.ROOT) ?: "eq") {
            "eq" -> actual == v.trim()
            "ne" -> actual != v.trim()
            "contains" -> actual.contains(v)
            "startswith" -> actual.startsWith(v.trim())
            "endswith" -> actual.endsWith(v.trim())
            "regex" -> try { Pattern.compile(v).matcher(actual).find() } catch (e: Exception) { false }
            "exists" -> actual.isNotEmpty()
            else -> actual == v.trim()
        }
    }

    /** 템플릿 렌더 — 요청 바이트 슬라이스/필드명/seq/now/uuid. */
    @JvmStatic
    fun renderTemplate(template: String, req: ByteArray, cs: Charset, reqFields: List<ReqField> = emptyList(), seq: Long = 0L): String {
        if (template.isEmpty() || !template.contains("{{")) {
            return template
        }
        val byName = reqFields.associate { it.name to it.value }
        val m = TOKEN.matcher(template)
        val sb = StringBuilder()
        while (m.find()) {
            val whole = m.group(1)
            val rep = when {
                whole == "seq" -> seq.toString()
                whole == "now" -> java.time.Instant.now().toString()
                whole == "uuid" -> UUID.randomUUID().toString()
                m.group(4) != null -> byName[m.group(4)] ?: ""
                m.group(2) != null -> String(TcpBytes.slice(req, m.group(2).toInt(), m.group(3).toInt()), cs)
                else -> String(req, cs)
            }
            m.appendReplacement(sb, Matcher.quoteReplacement(rep))
        }
        m.appendTail(sb)
        return sb.toString()
    }

    /** 규칙 응답 본문(프리픽스 제외) — 필드 모드면 바이트 조립, 아니면 텍스트 템플릿. */
    @JvmStatic
    fun render(rule: MockTcpRule?, req: ByteArray, cs: Charset, reqFields: List<ReqField>, seq: Long): Rendered {
        val fields = rule?.responseFieldsOrEmpty() ?: emptyList()
        if (fields.isEmpty()) {
            return Rendered(renderTemplate(rule?.response ?: "", req, cs, reqFields, seq).toByteArray(cs), emptyList())
        }
        var total = 0L
        for (f in fields) {
            val len = f.length ?: 0
            if (len < 0) throw IllegalArgumentException("필드 길이는 음수일 수 없습니다: ${f.name}=$len")
            total += len
            if (total > MAX_FIELD_TOTAL) throw IllegalArgumentException("응답 전문 총 길이가 상한(${MAX_FIELD_TOTAL}B)을 초과했습니다.")
        }
        val buf = ByteArrayOutputStream()
        val slices = ArrayList<RespSlice>()
        var offset = 0
        for (f in fields) {
            val fcs = TcpBytes.charset(f.encoding, cs)
            val v = renderTemplate(f.value ?: "", req, cs, reqFields, seq)
            val declared = f.length ?: 0
            val actual = v.toByteArray(fcs).size
            buf.writeBytes(TcpBytes.fixedField(v, declared, f.pad, f.padChar, fcs))
            slices.add(RespSlice(
                f.name, offset, declared, actual, actual > declared, actual < declared,
                if ("left".equals(f.pad, ignoreCase = true)) "left" else "right", v, fcs.name(),
            ))
            offset += declared
        }
        return Rendered(buf.toByteArray(), slices)
    }

    /** 미리보기 — 샘플 요청 텍스트를 tcp.charset 으로 인코딩해 실제 리스너와 같은 경로로 처리. */
    @JvmStatic
    fun preview(tcp: MockTcp, sample: String, seq: Long = 1001L): Preview {
        val cs = charsetOf(tcp.charset)
        val req = sample.toByteArray(cs)
        val reqFields = sliceRequest(tcp, req, cs)
        val rules = tcp.rulesOrEmpty()
        val rule = matchRule(rules, String(req, cs), reqFields)
        val rendered = render(rule, req, cs, reqFields, seq)
        val prefixLen = maxOf(tcp.prefixLength ?: 4, 0)
        val includesSelf = tcp.prefixIncludesSelf == true
        val message = TcpBytes.withPrefix(rendered.body, prefixLen, includesSelf)
        val declared = if (prefixLen > 0) (if (includesSelf) rendered.body.size + prefixLen else rendered.body.size) else null
        return Preview(
            encoding = cs.name(), requestFields = reqFields, requestBytes = req.size,
            matchedRuleId = rule?.id, matchedRuleIndex = rule?.let { rules.indexOf(it) },
            totalBytes = message.size, prefixLen = prefixLen, declaredPrefix = declared, bodyBytes = rendered.body.size,
            hex = TcpBytes.hexDump(message), printable = TcpBytes.printable(message, cs),
            fields = rendered.fields.map { it.copy(offset = it.offset + prefixLen) }, // 절대 오프셋(프리픽스 포함)
        )
    }
}
