package com.flowlink.mock

import com.flowlink.common.tcp.TcpBytes
import com.flowlink.mock.MockSpec.MockTcp
import com.flowlink.mock.MockSpec.MockTcpCond
import com.flowlink.mock.MockSpec.MockTcpRule
import com.flowlink.transform.FlowTransform
import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.util.Locale
import java.util.regex.Pattern

/**
 * TCP mock 순수 엔진 — 요청 전문 필드 슬라이싱 · 규칙 매칭(contains + 필드 조건) · 응답 조립(텍스트 템플릿 또는 필드별 바이트)
 * · 코덱(요청 전 body/fields, 응답 후 fields(패딩 전)/body). 소켓/스레드 없음(리스너·미리보기 API 공용). 길이는 전부 바이트(TcpBytes).
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

    /** 한 전문 처리 결과(리스너·미리보기 공용) — 코덱까지 적용된 상태. */
    class Processed(
        val reqText: String,                 // 요청 코덱(body) 적용 후 디코딩 전문(매칭 기준)
        val reqFields: List<ReqField>,       // 요청 코덱(fields) 적용 후 필드 값
        val rule: MockTcpRule?,
        val body: ByteArray,                 // 응답 본문(프리픽스 제외, 응답 코덱 적용)
        val fields: List<RespSlice>,
        val traces: List<MockCodec.StepTrace>,
    )

    /** 미리보기(저장·소켓 없음): 샘플 요청 → 필드 분해 + 매칭 규칙 + 응답 hex/텍스트/필드 + 코덱 단계 기록. */
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
        val decodedRequest: String? = null,      // 요청 코덱이 있을 때 디코딩된 전문
        val codecSteps: List<MockCodec.StepTrace> = emptyList(),
    )

    const val MAX_FIELD_TOTAL = 1 shl 20 // 1MB — ByteArray(length) 직접 할당 가드(미리보기 API 가 임의 spec 을 받음)

    private val NO_LOOKUP: (String) -> FlowTransform? = { null }

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

    private fun ctxOf(req: ByteArray, cs: Charset, reqFields: List<ReqField>, seq: Long, base: MockContext?): MockContext =
        MockContext(
            req = base?.req, pathParams = base?.pathParams ?: emptyMap(), seq = seq, state = base?.state ?: emptyMap(),
            secrets = base?.secrets ?: emptyMap(), tcpReq = req, tcpCharset = cs, tcpFields = reqFields.associate { it.name to it.value }, json = base?.json,
        )

    /** 템플릿 렌더 — 요청 바이트 슬라이스/필드명/seq/now/uuid(+시크릿). [MockTemplate] 위임. */
    @JvmStatic
    fun renderTemplate(template: String, req: ByteArray, cs: Charset, reqFields: List<ReqField> = emptyList(), seq: Long = 0L, base: MockContext? = null): String =
        MockTemplate.render(template, ctxOf(req, cs, reqFields, seq, base))

    /**
     * 규칙 응답 본문(프리픽스 제외) — 필드 모드면 바이트 조립, 아니면 텍스트 템플릿.
     * [respSteps] 가 있으면 필드 모드에서 target=fields 단계를 **패딩 전** 값에 적용한다(body 단계는 [process] 가 전체에 적용).
     */
    @JvmStatic
    fun render(
        rule: MockTcpRule?, req: ByteArray, cs: Charset, reqFields: List<ReqField>, seq: Long,
        base: MockContext? = null, respSteps: List<MockSpec.MockCodecStep>? = null, lookup: (String) -> FlowTransform? = NO_LOOKUP,
        trace: MutableList<MockCodec.StepTrace>? = null,
    ): Rendered {
        val ctx = ctxOf(req, cs, reqFields, seq, base)
        val fields = rule?.responseFieldsOrEmpty() ?: emptyList()
        if (fields.isEmpty()) {
            return Rendered(MockTemplate.render(rule?.response ?: "", ctx).toByteArray(cs), emptyList())
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
            var v = MockTemplate.render(f.value ?: "", ctx)
            val name = f.name?.trim().orEmpty()
            if (name.isNotEmpty() && !respSteps.isNullOrEmpty()) v = MockCodec.applyTcpField(respSteps, name, v, ctx, lookup, trace)
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

    /**
     * 한 전문 처리 — 요청 코덱(body → 디코딩 전문 재슬라이스, fields → 필드 값만) → 매칭 → 응답 렌더(필드 코덱) → 응답 body 코덱.
     * 리스너와 미리보기가 같은 경로. 코덱 실패는 [MockCodec.CodecException].
     */
    @JvmStatic
    fun process(
        tcp: MockTcp, codec: MockSpec.MockCodec?, reqBytes: ByteArray, cs: Charset, seq: Long,
        secrets: Map<String, String> = emptyMap(), lookup: (String) -> FlowTransform? = NO_LOOKUP,
    ): Processed {
        val traces = ArrayList<MockCodec.StepTrace>()
        val base = MockContext(secrets = secrets)
        var bytes = reqBytes
        var text = String(bytes, cs)
        var fields = sliceRequest(tcp, bytes, cs)
        val reqSteps = codec?.request
        if (!reqSteps.isNullOrEmpty()) {
            // body 단계: 전문 전체 디코딩 → 바이트/필드 재계산. fields 단계: 필드 값만 변환(전문 원문은 유지).
            for ((i, step) in reqSteps.withIndex()) {
                when (step.targetOrBody()) {
                    "fields" -> {
                        val ctx = ctxOf(bytes, cs, fields, seq, base)
                        fields = fields.map { f ->
                            if (f.name.isNotEmpty() && f.name in step.fieldsOrEmpty()) {
                                val out = MockCodec.applyStep(step, i, f.value, ctx, lookup)
                                traces.add(MockCodec.StepTrace(i, step.id ?: "", "fields", f.name, f.value, out))
                                f.copy(value = out)
                            } else f
                        }
                    }
                    "header" -> { /* TCP 에는 헤더가 없다 — 무시 */ }
                    else -> {
                        val ctx = ctxOf(bytes, cs, fields, seq, base)
                        val out = MockCodec.applyStep(step, i, text, ctx, lookup)
                        traces.add(MockCodec.StepTrace(i, step.id ?: "", "body", null, text, out))
                        text = out
                        bytes = text.toByteArray(cs)
                        fields = sliceRequest(tcp, bytes, cs)
                    }
                }
            }
        }
        val rule = matchRule(tcp.rulesOrEmpty(), text, fields)
        val respSteps = codec?.response
        val rendered = render(rule, bytes, cs, fields, seq, base, respSteps, lookup, traces)
        var body = rendered.body
        if (!respSteps.isNullOrEmpty() && respSteps.any { it.targetOrBody() == "body" }) {
            val ctx = ctxOf(bytes, cs, fields, seq, base)
            body = MockCodec.applyTcpBody(respSteps, String(body, cs), ctx, lookup, traces).toByteArray(cs)
        }
        return Processed(text, fields, rule, body, rendered.fields, traces)
    }

    /** 미리보기 — 샘플 요청 텍스트를 tcp.charset 으로 인코딩해 실제 리스너와 같은 경로([process])로 처리. */
    @JvmStatic
    fun preview(
        tcp: MockTcp, sample: String, seq: Long = 1001L,
        codec: MockSpec.MockCodec? = null, secrets: Map<String, String> = emptyMap(), lookup: (String) -> FlowTransform? = NO_LOOKUP,
    ): Preview {
        val cs = charsetOf(tcp.charset)
        val req = sample.toByteArray(cs)
        val p = process(tcp, codec, req, cs, seq, secrets, lookup)
        val rules = tcp.rulesOrEmpty()
        val prefixLen = maxOf(tcp.prefixLength ?: 4, 0)
        val includesSelf = tcp.prefixIncludesSelf == true
        val message = TcpBytes.withPrefix(p.body, prefixLen, includesSelf)
        val declared = if (prefixLen > 0) (if (includesSelf) p.body.size + prefixLen else p.body.size) else null
        val hasReqCodec = !codec?.request.isNullOrEmpty()
        return Preview(
            encoding = cs.name(), requestFields = p.reqFields, requestBytes = req.size,
            matchedRuleId = p.rule?.id, matchedRuleIndex = p.rule?.let { rules.indexOf(it) },
            totalBytes = message.size, prefixLen = prefixLen, declaredPrefix = declared, bodyBytes = p.body.size,
            hex = TcpBytes.hexDump(message), printable = TcpBytes.printable(message, cs),
            fields = p.fields.map { it.copy(offset = it.offset + prefixLen) }, // 절대 오프셋(프리픽스 포함)
            decodedRequest = if (hasReqCodec) p.reqText else null,
            codecSteps = p.traces,
        )
    }
}
